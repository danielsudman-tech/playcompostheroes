import { Router, type IRouter } from "express";
import { logEvent } from "../lib/analyticsStore.js";
import {
  activateOngoing,
  addBotToRoom,
  addPlayerToRoom,
  createGameState,
  createWaitingRoom,
  drawCardAction,
  endTurn,
  launchGame,
  moveCardLayer,
  playCard,
  removePlayerFromRoom,
  resolveDecision,
  runBotTurnsIfNeeded,
  type BotSkillLevel,
  type GameState,
} from "../lib/gameEngine.js";
import {
  addSseClient,
  getAllWaitingRooms,
  broadcastToGame,
  checkGamePassword,
  claimSlot,
  createGameId,
  gameHasPassword,
  getGame,
  getPlayerIndexForToken,
  removePlayerTokenByIndex,
  removeSseClient,
  sendKickedEvent,
  sendNudgeEvent,
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
  const { deck, ...rest } = state;
  return {
    ...rest,
    deckCount: deck.length,
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

// GET /api/rooms — list all open waiting rooms
router.get("/rooms", async (_req, res) => {
  try {
    res.json(await getAllWaitingRooms());
  } catch (err) {
    res.status(500).json({ error: "Failed to load rooms" });
  }
});

// POST /api/games — create a new game
router.post("/games", async (req, res) => {
  const { playerNames, mode, password, hostName, maxPlayers, botPlayerIndices, botSkillLevels } = req.body as {
    playerNames?: string[];
    mode: "facilitator" | "standalone" | "online";
    password?: string;
    hostName?: string;
    maxPlayers?: number;
    botPlayerIndices?: number[];
    botSkillLevels?: Record<number, BotSkillLevel>;
  };

  if (mode !== "facilitator" && mode !== "standalone" && mode !== "online") {
    res.status(400).json({ error: "mode must be facilitator, standalone, or online" });
    return;
  }

  // Online waiting-room: just the host name + max players
  if (mode === "online") {
    const name = (hostName ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "hostName is required for online games" });
      return;
    }
    const max = Math.min(4, Math.max(2, Number(maxPlayers) || 4));
    const gameId = createGameId();
    const state = createWaitingRoom(gameId, name, max, "online");
    await storeGame(state);
    logEvent("game_created", { gameId, metadata: { mode: "online", maxPlayers: max, hostName: name } });

    if (password && password.trim()) {
      await setGamePassword(gameId, password.trim());
    }

    const claimed = await claimSlot(gameId);
    const serialized = serializeState(state, claimed?.playerIndex);
    res.status(201).json({
      ...serialized,
      hasPassword: await gameHasPassword(gameId),
      creatorToken: claimed?.token ?? null,
    });
    return;
  }

  // Pass & Play / Facilitator
  if (!Array.isArray(playerNames) || playerNames.length < 2 || playerNames.length > 4) {
    res.status(400).json({ error: "Need 2-4 player names" });
    return;
  }

  const gameId = createGameId();
  const validBotIndices = Array.isArray(botPlayerIndices)
    ? botPlayerIndices.filter((i) => typeof i === "number" && i >= 0 && i < playerNames.length)
    : [];
  const validSkillLevels: Record<number, BotSkillLevel> = {};
  if (botSkillLevels && typeof botSkillLevels === "object") {
    for (const [k, v] of Object.entries(botSkillLevels)) {
      const idx = Number(k);
      if (!isNaN(idx) && (v === "easy" || v === "medium" || v === "hard")) {
        validSkillLevels[idx] = v;
      }
    }
  }
  let state = createGameState(gameId, playerNames, mode, validBotIndices, validSkillLevels);
  state = runBotTurnsIfNeeded(state);
  await storeGame(state);
  logEvent("game_created", { gameId, intValue: playerNames.length, metadata: { mode, bots: validBotIndices.length } });

  res.status(201).json(serializeState(state));
});

// GET /api/games/:gameId — get game state
router.get("/games/:gameId", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const token = req.query.token as string | undefined;
  const state = await getGame(gameId);
  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const viewerIndex =
    token ? (await getPlayerIndexForToken(gameId, token) ?? undefined) : undefined;
  res.json({ ...serializeState(state, viewerIndex), hasPassword: await gameHasPassword(gameId) });
});

// POST /api/games/:gameId/claim — claim a player slot
router.post("/games/:gameId/claim", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token: existingToken, password } = req.body as { token?: string; password?: string };

  const state = await getGame(gameId);
  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  if (await gameHasPassword(gameId) && !existingToken) {
    if (!password) {
      res.status(403).json({ error: "This game is password protected", requiresPassword: true });
      return;
    }
    if (!await checkGamePassword(gameId, password)) {
      res.status(403).json({ error: "Incorrect password", requiresPassword: true });
      return;
    }
  }

  const claimed = await claimSlot(gameId, existingToken);
  if (!claimed) {
    res.status(409).json({ error: "Game is full — all player slots are taken" });
    return;
  }

  const { token, playerIndex } = claimed;
  const player = state.players[playerIndex];
  res.json({ token, playerIndex, playerId: player.id, playerName: player.name });
});

// POST /api/games/:gameId/join — join a waiting-room game
router.post("/games/:gameId/join", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { name, password } = req.body as { name?: string; password?: string };

  const state = await getGame(gameId);
  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  if (state.phase !== "waiting") {
    res.status(409).json({ error: "Game already started" });
    return;
  }

  if (await gameHasPassword(gameId)) {
    if (!password) {
      res.status(403).json({ error: "This game is password protected", requiresPassword: true });
      return;
    }
    if (!await checkGamePassword(gameId, password)) {
      res.status(403).json({ error: "Incorrect password", requiresPassword: true });
      return;
    }
  }

  const trimmedName = (name ?? "").trim();
  if (!trimmedName) {
    res.status(400).json({ error: "Name is required" });
    return;
  }

  const result = addPlayerToRoom(state, trimmedName);
  if ("error" in result) {
    res.status(409).json({ error: result.error });
    return;
  }

  await storeGame(result.state);
  logEvent("player_joined", { gameId, metadata: { playerName: trimmedName, playerCount: result.state.players.length } });

  const claimed = await claimSlot(gameId);
  if (!claimed) {
    res.status(409).json({ error: "Failed to assign player slot" });
    return;
  }

  broadcastToGame(gameId, result.state, serializeState);

  const player = result.state.players[claimed.playerIndex];
  res.status(201).json({
    token: claimed.token,
    playerIndex: claimed.playerIndex,
    playerId: player.id,
    playerName: player.name,
  });
});

// POST /api/games/:gameId/start — host launches the game
router.post("/games/:gameId/start", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token, botSlots } = req.body as {
    token?: string;
    botSlots?: Array<{ name: string; skillLevel?: string }>;
  };

  let state = await getGame(gameId);
  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const viewerIndex = token
    ? (await getPlayerIndexForToken(gameId, token) ?? undefined)
    : undefined;
  if (viewerIndex !== 0) {
    res.status(403).json({ error: "Only the host can start the game" });
    return;
  }

  // Add bot players to fill empty slots before launching
  if (botSlots && botSlots.length > 0) {
    for (const bot of botSlots) {
      const result = addBotToRoom(
        state,
        bot.name || "Bot",
        (bot.skillLevel as BotSkillLevel) || "medium"
      );
      if ("error" in result) {
        res.status(400).json({ error: result.error });
        return;
      }
      state = result.state;
    }
  }

  const launched = launchGame(state);
  if (launched.error) {
    res.status(400).json({ error: launched.error });
    return;
  }

  const launchedState = runBotTurnsIfNeeded(launched.state);
  await storeGame(launchedState);
  broadcastToGame(gameId, launchedState, serializeState);

  res.json(serializeState(launchedState, viewerIndex));
});

// GET /api/games/:gameId/events — SSE real-time stream
router.get("/games/:gameId/events", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const token = req.query.token as string | undefined;
  const state = await getGame(gameId);

  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  if (!token) {
    res.status(400).json({ error: "token query param required" });
    return;
  }

  const viewerIndex = await getPlayerIndexForToken(gameId, token) ?? undefined;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sseWrite = (chunk: string) => {
    res.write(chunk);
    (res as any).flush?.();
  };

  sseWrite(`data: ${JSON.stringify(serializeState(state, viewerIndex))}\n\n`);

  addSseClient(gameId, token, res);

  const ping = setInterval(() => {
    try {
      sseWrite(": ping\n\n");
    } catch {
      clearInterval(ping);
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(ping);
    removeSseClient(gameId, token);
  });
});

// POST /api/games/:gameId/nudge — poke the current player when it's their turn
router.post("/games/:gameId/nudge", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token, targetPlayerIndex } = req.body as { token?: string; targetPlayerIndex?: number };

  if (!token || targetPlayerIndex === undefined) {
    res.status(400).json({ error: "token and targetPlayerIndex required" });
    return;
  }

  const state = await getGame(gameId);
  if (!state) { res.status(404).json({ error: "Game not found" }); return; }

  const senderIndex = await getPlayerIndexForToken(gameId, token);
  if (senderIndex === undefined || senderIndex === null) { res.status(403).json({ error: "Invalid token" }); return; }

  const senderName = state.players[senderIndex]?.name ?? "Someone";
  await sendNudgeEvent(gameId, targetPlayerIndex, senderName);
  res.json({ ok: true });
});

// POST /api/games/:gameId/action — perform a game action
router.post("/games/:gameId/action", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const state = await getGame(gameId);
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

  try {
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
        const data: Record<string, unknown> = { ...(decisionData ?? {}) };
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
        const targetFunction = (req.body as any).targetFunction as string | undefined;
        result = moveCardLayer(state, playerId, cardId, targetFunction);
        break;
      }
      case "reset_game": {
        const playerNames = state.players.map((p) => p.name);
        const botIndices = state.players
          .map((p, i) => ((p as any).isBot ? i : -1))
          .filter((i) => i >= 0);
        const botSkillLevels: Record<number, string> = {};
        state.players.forEach((p, i) => {
          if ((p as any).isBot && (p as any).botSkillLevel) {
            botSkillLevels[i] = (p as any).botSkillLevel;
          }
        });
        // Reuse the same gameId so the URL and React Query cache stay valid
        let newState = createGameState(gameId, playerNames, state.mode as "facilitator" | "standalone", botIndices, botSkillLevels);
        newState = runBotTurnsIfNeeded(newState);
        await storeGame(newState);
        broadcast(newState.gameId, newState);
        res.json(serializeState(newState));
        return;
      }
      default:
        res.status(400).json({ error: `Unknown action type: ${type}` });
        return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[game action] ${type} threw an exception:`, err);
    res.status(500).json({ error: `Server error processing ${type}: ${msg}` });
    return;
  }

  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }

  const stateAfterBots = runBotTurnsIfNeeded(result.state);
  await storeGame(stateAfterBots);
  if (stateAfterBots.phase === "game_over" && state.phase !== "game_over") {
    logEvent("game_completed", {
      gameId,
      intValue: stateAfterBots.players.length,
      metadata: { winner: (stateAfterBots as any).winner ?? null, mode: stateAfterBots.mode },
    });
  }
  broadcast(gameId, stateAfterBots);

  const viewerIndex =
    token ? (await getPlayerIndexForToken(gameId, token) ?? undefined) : undefined;
  res.json(serializeState(stateAfterBots, viewerIndex));
});

// DELETE /api/games/:gameId/players/:playerId — leave or kick
router.delete("/games/:gameId/players/:playerId", async (req, res) => {
  const { gameId, playerId } = req.params as { gameId: string; playerId: string };
  const { token } = req.body as { token?: string };

  if (!token) {
    res.status(401).json({ error: "Token required" });
    return;
  }

  const state = await getGame(gameId);
  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const requesterIndex = await getPlayerIndexForToken(gameId, token);
  if (requesterIndex === null) {
    res.status(403).json({ error: "Invalid token" });
    return;
  }

  const requester = state.players[requesterIndex];
  const target = state.players.find((p) => p.id === playerId);

  if (!target) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  const isSelf = requester?.id === playerId;
  const isHost = requesterIndex === 0;

  if (!isSelf && !isHost) {
    res.status(403).json({ error: "Only the host can kick other players" });
    return;
  }

  const result = removePlayerFromRoom(state, playerId);
  if ("error" in result) {
    res.status(400).json({ error: result.error });
    return;
  }

  const removedToken = await removePlayerTokenByIndex(gameId, result.removedIndex);

  if (removedToken) {
    sendKickedEvent(gameId, removedToken);
  }

  await storeGame(result.state);

  if (result.state.players.length > 0) {
    broadcast(gameId, result.state);
  }

  res.json({ success: true });
});

export default router;
