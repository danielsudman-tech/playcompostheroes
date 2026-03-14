import { Router, type IRouter } from "express";
import {
  activateOngoing,
  createGameState,
  drawCardAction,
  endTurn,
  moveCardLayer,
  playCard,
  resolveDecision,
  type GameState,
} from "../lib/gameEngine.js";
import {
  addSseClient,
  broadcastToGame,
  checkGamePassword,
  claimSlot,
  createGameId,
  gameHasPassword,
  getGame,
  getPlayerIndexForToken,
  removeSseClient,
  setGamePassword,
  storeGame,
} from "../lib/gameStore.js";

const router: IRouter = Router();

// ─── Serialization ────────────────────────────────────────────────────────────

const HIDDEN_CARD = {
  id: "back",
  name: "Card Back",
  type: "unknown",
  layer: null,
  effectType: "instant",
  cardText: "",
  factText: "",
  function: "",
  imageKey: "card_back.jpg",
};

function serializeState(state: GameState, viewerIndex?: number) {
  const isOnline = state.mode === "online";
  return {
    ...state,
    deck: state.deck.map(() => HIDDEN_CARD),
    players: state.players.map((player, idx) => {
      if (!isOnline || viewerIndex === undefined || idx === viewerIndex) {
        return player;
      }
      return { ...player, hand: player.hand.map(() => HIDDEN_CARD) };
    }),
  };
}

// ─── Broadcast helper ────────────────────────────────────────────────────────

function broadcast(gameId: string, state: GameState) {
  broadcastToGame(gameId, state, serializeState);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/games — create a new game
router.post("/games", (req, res) => {
  const { playerNames, mode, password } = req.body as {
    playerNames: string[];
    mode: "facilitator" | "standalone" | "online";
    password?: string;
  };

  if (
    !Array.isArray(playerNames) ||
    playerNames.length < 2 ||
    playerNames.length > 4
  ) {
    res.status(400).json({ error: "Need 2-4 player names" });
    return;
  }

  if (mode !== "facilitator" && mode !== "standalone" && mode !== "online") {
    res
      .status(400)
      .json({ error: "mode must be facilitator, standalone, or online" });
    return;
  }

  const gameId = createGameId();
  const state = createGameState(gameId, playerNames, mode);
  storeGame(state);

  if (password && password.trim()) {
    setGamePassword(gameId, password.trim());
  }

  // In online mode, auto-claim slot 0 for the creator and return the token
  if (mode === "online") {
    const claimed = claimSlot(gameId);
    const serialized = serializeState(state, claimed?.playerIndex);
    res
      .status(201)
      .json({ ...serialized, creatorToken: claimed?.token ?? null });
    return;
  }

  res.status(201).json(serializeState(state));
});

// GET /api/games/:gameId — get game state (filtered for online mode)
router.get("/games/:gameId", (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const token = req.query.token as string | undefined;
  const state = getGame(gameId);
  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const viewerIndex =
    token ? (getPlayerIndexForToken(gameId, token) ?? undefined) : undefined;
  res.json({ ...serializeState(state, viewerIndex), hasPassword: gameHasPassword(gameId) });
});

// POST /api/games/:gameId/claim — claim a player slot
router.post("/games/:gameId/claim", (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token: existingToken, password } = req.body as { token?: string; password?: string };

  const state = getGame(gameId);
  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  // If the game has a password and this is a NEW join (no valid existing token),
  // require a correct password before granting a slot.
  if (gameHasPassword(gameId) && !existingToken) {
    if (!password) {
      res.status(403).json({ error: "This game is password protected", requiresPassword: true });
      return;
    }
    if (!checkGamePassword(gameId, password)) {
      res.status(403).json({ error: "Incorrect password", requiresPassword: true });
      return;
    }
  }

  const claimed = claimSlot(gameId, existingToken);
  if (!claimed) {
    res.status(409).json({ error: "Game is full — all player slots are taken" });
    return;
  }

  const { token, playerIndex } = claimed;
  const player = state.players[playerIndex];
  res.json({
    token,
    playerIndex,
    playerId: player.id,
    playerName: player.name,
  });
});

// GET /api/games/:gameId/events — SSE real-time stream
router.get("/games/:gameId/events", (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const token = req.query.token as string | undefined;
  const state = getGame(gameId);

  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  if (!token) {
    res.status(400).json({ error: "token query param required" });
    return;
  }

  const viewerIndex = getPlayerIndexForToken(gameId, token) ?? undefined;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Send current state immediately
  res.write(`data: ${JSON.stringify(serializeState(state, viewerIndex))}\n\n`);

  addSseClient(gameId, token, res);

  // Keep-alive ping every 25 s
  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(ping);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(ping);
    removeSseClient(gameId, token);
  });
});

// POST /api/games/:gameId/action — perform a game action
router.post("/games/:gameId/action", (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const state = getGame(gameId);
  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const {
    type,
    playerId,
    cardId,
    targetPlayerId,
    targetCardId,
    decisionData,
    token,
  } = req.body as {
    type: string;
    playerId: string;
    cardId?: string;
    targetPlayerId?: string;
    targetCardId?: string;
    decisionData?: Record<string, unknown>;
    token?: string;
  };

  let result: { state: typeof state; error?: string };

  switch (type) {
    case "draw_card": {
      result = drawCardAction(state, playerId);
      break;
    }
    case "play_card": {
      if (!cardId) {
        res.status(400).json({ error: "cardId required for play_card" });
        return;
      }
      result = playCard(state, playerId, cardId);
      break;
    }
    case "end_turn": {
      result = endTurn(state, playerId);
      break;
    }
    case "resolve_decision": {
      const data: Record<string, unknown> = {
        ...(decisionData ?? {}),
      };
      if (targetPlayerId) data.targetPlayerId = targetPlayerId;
      if (targetCardId) data.targetCardId = targetCardId;
      if (cardId) data.cardId = cardId;
      result = resolveDecision(state, playerId, data);
      break;
    }
    case "activate_ongoing": {
      result = activateOngoing(state, playerId);
      break;
    }
    case "move_card_layer": {
      if (!cardId) {
        res.status(400).json({ error: "cardId required for move_card_layer" });
        return;
      }
      result = moveCardLayer(state, playerId, cardId);
      break;
    }
    case "reset_game": {
      const players = state.players.map((p) => p.name);
      const newState = createGameState(createGameId(), players, state.mode);
      storeGame(newState);
      broadcast(newState.gameId, newState);
      res.json(serializeState(newState));
      return;
    }
    default:
      res.status(400).json({ error: `Unknown action type: ${type}` });
      return;
  }

  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }

  storeGame(result.state);
  broadcast(gameId, result.state);

  // Return filtered state for the requesting player
  const viewerIndex =
    token ? (getPlayerIndexForToken(gameId, token) ?? undefined) : undefined;
  res.json(serializeState(result.state, viewerIndex));
});

export default router;
