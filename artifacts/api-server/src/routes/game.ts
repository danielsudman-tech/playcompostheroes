import { Router, type IRouter } from "express";
import {
  activateOngoing,
  createGameState,
  drawCardAction,
  endTurn,
  moveCardLayer,
  playCard,
  resolveDecision,
} from "../lib/gameEngine.js";
import { createGameId, getGame, storeGame } from "../lib/gameStore.js";

const router: IRouter = Router();

// POST /api/games — create a new game
router.post("/games", (req, res) => {
  const { playerNames, mode } = req.body as {
    playerNames: string[];
    mode: "facilitator" | "standalone";
  };

  if (
    !Array.isArray(playerNames) ||
    playerNames.length < 2 ||
    playerNames.length > 4
  ) {
    res.status(400).json({ error: "Need 2-4 player names" });
    return;
  }

  if (mode !== "facilitator" && mode !== "standalone") {
    res.status(400).json({ error: "mode must be facilitator or standalone" });
    return;
  }

  const gameId = createGameId();
  const state = createGameState(gameId, playerNames, mode);
  storeGame(state);
  res.status(201).json(serializeState(state));
});

// GET /api/games/:gameId — get game state
router.get("/games/:gameId", (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const state = getGame(gameId);
  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  res.json(serializeState(state));
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
  } = req.body as {
    type: string;
    playerId: string;
    cardId?: string;
    targetPlayerId?: string;
    targetCardId?: string;
    decisionData?: Record<string, unknown>;
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
  res.json(serializeState(result.state));
});

function serializeState(state: ReturnType<typeof createGameState>) {
  return {
    ...state,
    // Hide deck cards (only expose count)
    deck: state.deck.map(() => ({
      id: "back",
      name: "Card Back",
      type: "unknown",
      layer: null,
      effectType: "instant",
      cardText: "",
      factText: "",
      function: "",
      imageKey: "card_back.jpg",
    })),
  };
}

export default router;
