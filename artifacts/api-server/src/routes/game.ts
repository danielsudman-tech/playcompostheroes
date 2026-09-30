import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
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
  acquireGameMutationLock,
  getAllWaitingRooms,
  broadcastToGame,
  checkGamePassword,
  claimSlot,
  createGameId,
  createSpectatorHostToken,
  gameHasPassword,
  getGame,
  getEventForGame,
  getGamesByFacilitator,
  getGameIdForToken,
  getTokenForPlayerIndex,
  getPlayerIndexForToken,
  kickFacilitatedPlayer,
  isEventGameReadyToStart,
  removePlayerTokenByIndex,
  removeEventWaitingPlayer,
  removeSseClient,
  reorderWaitingPlayers,
  sendKickedEvent,
  sendNudgeEvent,
  sendRoomTransferEvent,
  setGamePassword,
  storeGame,
  transferWaitingPlayer,
  releaseGameMutationLock,
  withGameMutationLocks,
} from "../lib/gameStore.js";
import { buildEffectAnnouncement, findEffectCard, serializeEffectAnnouncement } from "../lib/facilitatedEffects.js";
import { getUserByToken, isApprovedFacilitator, type CompostUser } from "../lib/userStore.js";

// Registration rules: online games (and facilitated hosting) require a
// registered account. Facilitated participants and Pass & Play never do.
async function getRegisteredUser(userToken: unknown): Promise<CompostUser | null> {
  if (typeof userToken !== "string" || !userToken.trim()) return null;
  try {
    return await getUserByToken(userToken);
  } catch {
    return null;
  }
}

async function requireRegisteredUser(userToken: unknown): Promise<boolean> {
  return (await getRegisteredUser(userToken)) !== null;
}

const router: IRouter = Router();

// Serialize every mutation of an event-linked game with event joins and host
// controls, and refresh the cache from durable state after acquiring the lock.
router.use("/games/:gameId", (req, res, next) => {
  if (req.method === "GET" || req.originalUrl.includes("/waiting/transfer")) return next();
  void (async () => {
    const gameId = req.params.gameId;
    const initialEvent = await getEventForGame(gameId);
    if (!initialEvent) return next();
    const isEnd = req.originalUrl.split("?")[0].endsWith("/end");
    const client = await acquireGameMutationLock(gameId);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await releaseGameMutationLock(client, gameId);
    };
    try {
      const event = await getEventForGame(gameId);
      if (event && ["ending", "completed"].includes(event.status) && !isEnd) {
        await release();
        res.status(409).json({ error: "Event is ending or has ended" });
        return;
      }
      const originalEnd = res.end.bind(res);
      (res as any).end = (...args: any[]) => {
        const result = originalEnd(...args);
        void release();
        return result;
      };
      res.once("close", () => {
        if (res.writableFinished) void release();
      });
      next();
    } catch (error) {
      await release();
      throw error;
    }
  })().catch(next);
});

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

export function serializeState(state: GameState, viewerIndex?: number) {
  const isOnline = state.mode === "online" || state.mode === "facilitated";
  const { deck, ...rest } = state;
  const viewerId = viewerIndex !== undefined && viewerIndex >= 0
    ? state.players[viewerIndex]?.id
    : undefined;

  // Effect details about a discarded hand card are withheld from the shared
  // state and materialized only for the viewer who owns that hand.
  const lastEffect = serializeEffectAnnouncement(state.lastEffect, viewerId, isOnline);

  // Hidden-information contract: a pending decision's options/meta can contain
  // hand-derived card identities (e.g. Worm Party, hand-choice decisions).
  // Only the decision owner may see them; everyone else gets just enough for
  // the waiting UI (type, owner, prompt).
  let pendingDecision = state.pendingDecision;
  if (isOnline && pendingDecision) {
    if (viewerId !== pendingDecision.playerId) {
      pendingDecision = { ...pendingDecision, options: [], meta: undefined };
    }
  }

  // Questions are facilitator-directed: the host sees them all;
  // every other viewer only sees their own (to render the "Asked" state).
  let questions = state.questions;
  const isFacilitatorViewer = state.mode === "facilitated" &&
    viewerIndex === (state.hostIsSpectator === true ? -1 : 0);
  if (isOnline && questions && !isFacilitatorViewer) {
    questions = questions.filter((q) => q.playerId === viewerId);
  }

  return {
    ...rest,
    lastEffect,
    pendingDecision,
    questions,
    deckCount: deck.length,
    players: state.players.map((player, idx) => {
      if (!isOnline || idx === viewerIndex) {
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
    mode: "facilitator" | "standalone" | "online" | "facilitated";
    password?: string;
    hostName?: string;
    maxPlayers?: number;
    botPlayerIndices?: number[];
    botSkillLevels?: Record<number, BotSkillLevel>;
  };

  if (mode !== "facilitator" && mode !== "standalone" && mode !== "online" && mode !== "facilitated") {
    res.status(400).json({ error: "mode must be facilitator, standalone, online, or facilitated" });
    return;
  }
  // The legacy facilitator play mode is privileged too; Pass & Play remains open.
  if (mode === "facilitator" && !isApprovedFacilitator(
    await getRegisteredUser((req.body as { userToken?: string }).userToken)
  )) {
    res.status(403).json({ error: "Facilitator approval is required" });
    return;
  }

  // Online / facilitated waiting-room: just the host name + max players.
  // Creating either requires a registered account.
  if (mode === "online" || mode === "facilitated") {
    const creator = await getRegisteredUser((req.body as { userToken?: string }).userToken);
    if (!creator) {
      res.status(401).json({ error: "Sign in required to create this kind of room" });
      return;
    }
    if (mode === "facilitated" && !isApprovedFacilitator(creator)) {
      res.status(403).json({ error: "Facilitator approval is required to host sessions" });
      return;
    }
    const name = (hostName ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "hostName is required for online games" });
      return;
    }
    const max = Math.min(4, Math.max(2, Number(maxPlayers) || 4));
    const gameId = createGameId();
    const state = createWaitingRoom(gameId, name, max, mode, mode === "facilitated");
    state.createdAt = Date.now();
    state.facilitatorId = creator.id;
    const label = ((req.body as { label?: string }).label ?? "").trim();
    if (label) state.label = label.slice(0, 60);
    await storeGame(state);
    logEvent("game_created", { gameId, metadata: { mode, maxPlayers: max, hostName: name } });

    if (password && password.trim()) {
      await setGamePassword(gameId, password.trim());
    }

    const creatorToken = mode === "facilitated"
      ? await createSpectatorHostToken(gameId)
      : (await claimSlot(gameId))?.token ?? null;
    const creatorIndex = mode === "facilitated" ? -1 : 0;
    const serialized = serializeState(state, creatorToken ? creatorIndex : undefined);
    res.status(201).json({
      ...serialized,
      hasPassword: await gameHasPassword(gameId),
      creatorToken,
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
  const { token: existingToken, password, userToken } = req.body as { token?: string; password?: string; userToken?: string };

  const state = await getGame(gameId);
  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  if (await getEventForGame(gameId) && !existingToken) {
    res.status(409).json({ error: "Join this event through its event code" });
    return;
  }

  // New claims on online games require a registered account. Rejoining with
  // an existing game token stays open (the token already proves membership).
  if (state.mode === "online" && !existingToken && !(await requireRegisteredUser(userToken))) {
    res.status(401).json({ error: "Sign in required to join an online game" });
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

  if (existingToken) {
    const tokenGameId = await getGameIdForToken(existingToken);
    if (!tokenGameId) {
      res.status(403).json({ error: "Invalid game token" });
      return;
    }
    if (tokenGameId !== gameId) {
      res.status(409).json({ redirectGameId: tokenGameId, targetToken: existingToken });
      return;
    }
  }

  const claimed = await claimSlot(gameId, existingToken);
  if (!claimed) {
    res.status(409).json({ error: "Game is full — all player slots are taken" });
    return;
  }

  const { token, playerIndex } = claimed;
  if (playerIndex === -1) {
    res.json({ token, playerIndex, playerId: null, playerName: "Host" });
    return;
  }
  const player = state.players[playerIndex];
  res.json({ token, playerIndex, playerId: player.id, playerName: player.name });
});

// POST /api/games/:gameId/join — join a waiting-room game
router.post("/games/:gameId/join", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { name, password, userToken } = req.body as { name?: string; password?: string; userToken?: string };

  if (await getEventForGame(gameId)) {
    res.status(409).json({ error: "Join this event through its event code" });
    return;
  }

  const state = await getGame(gameId);
  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  if (state.phase !== "waiting") {
    res.status(409).json({ error: "Game already started" });
    return;
  }

  // Online games require a registered account to join; facilitated
  // participants only need the code + a name.
  if (state.mode === "online" && !(await requireRegisteredUser(userToken))) {
    res.status(401).json({ error: "Sign in required to join an online game" });
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
  if (state.mode === "facilitated") {
    if (viewerIndex !== (state.hostIsSpectator === true ? -1 : 0)) {
      res.status(403).json({ error: "Only the host can start the game" });
      return;
    }
    const user = await getRegisteredUser(req.body?.userToken);
    if (!isApprovedFacilitator(user) || user?.id !== state.facilitatorId) {
      res.status(403).json({ error: "Facilitator approval is required" });
      return;
    }
  } else if (viewerIndex !== 0) {
    res.status(403).json({ error: "Only the host can start the game" });
    return;
  }

  const event = await getEventForGame(gameId);
  if (event) {
    if (botSlots !== undefined) {
      res.status(400).json({ error: "Event tables cannot be started with bot slots" });
      return;
    }
    if (!await isEventGameReadyToStart(gameId)) {
      res.status(409).json({ error: "Event table needs at least two seated, ready, connected guests" });
      return;
    }
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

  const launchedState = { ...runBotTurnsIfNeeded(launched.state), lastMeaningfulActivityAt: Date.now() };
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

  const tokenIndex = await getPlayerIndexForToken(gameId, token);
  if (tokenIndex === null) {
    res.status(403).json({ error: "Invalid token" });
    return;
  }
  const viewerIndex = tokenIndex;

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

  if (state.mode !== "online" && state.mode !== "facilitated") {
    res.status(400).json({ error: "Nudges are only available in multiplayer games" });
    return;
  }

  const senderIndex = await getPlayerIndexForToken(gameId, token);
  if (senderIndex === undefined || senderIndex === null) { res.status(403).json({ error: "Invalid token" }); return; }

  // Facilitated sessions: the reserved spectator (or legacy seat zero) may nudge.
  const hostIndex = state.hostIsSpectator === true ? -1 : 0;
  if (state.mode === "facilitated" && senderIndex !== hostIndex) {
    res.status(403).json({ error: "Only the facilitator (host) can nudge players" });
    return;
  }
  if (state.mode === "facilitated") {
    const user = await getRegisteredUser(req.body?.userToken);
    if (!isApprovedFacilitator(user) || user?.id !== state.facilitatorId) {
      res.status(403).json({ error: "Facilitator approval is required" });
      return;
    }
  }

  const target = Number(targetPlayerIndex);
  if (!Number.isInteger(target) || target < 0 || target >= state.players.length || target === senderIndex) {
    res.status(400).json({ error: "Invalid nudge target" });
    return;
  }

  const senderName = state.players[senderIndex]?.name ?? "Someone";
  await sendNudgeEvent(gameId, target, senderName);
  res.json({ ok: true });
});

// ─── Facilitator (host = player index 0) assist controls ────────────────────

async function requireHost(gameId: string, token: string | undefined, userToken: unknown): Promise<{ state: GameState; hostIndex: number } | { status: number; error: string }> {
  const state = await getGame(gameId);
  if (!state) return { status: 404, error: "Game not found" };
  if (state.mode !== "facilitated") return { status: 400, error: "Facilitator controls are only available in facilitated games" };
  if (!token) return { status: 403, error: "Host token required" };
  const idx = await getPlayerIndexForToken(gameId, token);
  const hostIndex = state.hostIsSpectator === true ? -1 : 0;
  if (idx !== hostIndex) return { status: 403, error: "Only the facilitator (host) can do this" };
  const user = await getRegisteredUser(userToken);
  if (!isApprovedFacilitator(user) || user?.id !== state.facilitatorId) {
    return { status: 403, error: "Facilitator approval is required" };
  }
  return { state, hostIndex };
}

// POST /api/games/:gameId/pause — facilitator pauses/resumes the game
router.post("/games/:gameId/pause", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token, paused } = req.body as { token?: string; paused?: boolean };

  const check = await requireHost(gameId, token, req.body?.userToken);
  if ("error" in check) { res.status(check.status).json({ error: check.error }); return; }

  const state: GameState = { ...check.state, paused: paused === true };
  state.log = [...state.log.slice(-49), paused === true ? "⏸️ The facilitator paused the game." : "▶️ The facilitator resumed the game."];
  await storeGame(state);
  broadcast(gameId, state);
  res.json(serializeState(state, check.hostIndex));
});

// GET /api/facilitator/rooms — sessions created by the signed-in facilitator
router.get("/facilitator/rooms", async (req, res) => {
  const user = await getRegisteredUser(req.query.userToken);
  if (!user) {
    res.status(401).json({ error: "Sign in required" });
    return;
  }
  if (!isApprovedFacilitator(user)) {
    res.status(403).json({ error: "Facilitator approval is required" });
    return;
  }
  try {
    const games = await getGamesByFacilitator(user.id);
    res.json(games.map((g) => ({
      gameId: g.gameId,
      mode: g.mode,
      label: g.label ?? null,
      phase: g.phase,
      playerCount: g.hostIsSpectator === true ? g.players.length : Math.max(0, g.players.length - 1),
      maxPlayers: g.hostIsSpectator === true
        ? (g.maxPlayers ?? 4)
        : Math.max(0, (g.maxPlayers ?? 4) - 1),
      createdAt: g.createdAt ?? null,
      endedAt: g.endedAt ?? null,
      winner: g.winner,
      paused: g.paused === true,
      openQuestions: (g.questions ?? []).filter((q) => !q.resolved).length,
    })));
  } catch (err) {
    console.error("[facilitator rooms]", err);
    res.status(500).json({ error: "Failed to load sessions" });
  }
});

// POST /api/games/:gameId/host-token — recover the host seat token for a
// session's creator (signed-in account), e.g. reopening from another device.
router.post("/games/:gameId/host-token", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const user = await getRegisteredUser((req.body as { userToken?: string }).userToken);
  if (!user) { res.status(401).json({ error: "Sign in required" }); return; }

  const state = await getGame(gameId);
  if (!state) { res.status(404).json({ error: "Game not found" }); return; }
  if (state.mode !== "facilitated" || state.facilitatorId !== user.id || !isApprovedFacilitator(user)) {
    res.status(403).json({ error: "You are not the facilitator of this session" });
    return;
  }
  const token = await getTokenForPlayerIndex(gameId, state.hostIsSpectator === true ? -1 : 0);
  if (!token) { res.status(404).json({ error: "Host seat token not found" }); return; }
  res.json({ token });
});

// POST /api/games/:gameId/message — facilitator broadcasts a message to all tables
router.post("/games/:gameId/message", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token, text } = req.body as { token?: string; text?: string };

  const check = await requireHost(gameId, token, req.body?.userToken);
  if ("error" in check) { res.status(check.status).json({ error: check.error }); return; }

  if (check.state.phase === "game_over") { res.status(409).json({ error: "The session has ended" }); return; }

  const trimmed = (text ?? "").trim();
  if (!trimmed) { res.status(400).json({ error: "Message text is required" }); return; }

  const state: GameState = {
    ...check.state,
    hostMessage: { id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, text: trimmed.slice(0, 300), ts: Date.now() },
  };
  state.log = [...state.log.slice(-49), `📢 Facilitator: ${trimmed.slice(0, 300)}`];
  await storeGame(state);
  broadcast(gameId, state);
  res.json(serializeState(state, check.hostIndex));
});

// POST /api/games/:gameId/question — participant flags a question for the facilitator
router.post("/games/:gameId/question", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token, text } = req.body as { token?: string; text?: string };

  const state = await getGame(gameId);
  if (!state) { res.status(404).json({ error: "Game not found" }); return; }
  if (state.mode !== "facilitated") { res.status(400).json({ error: "Questions are only available in facilitated games" }); return; }
  if (state.phase === "game_over") { res.status(409).json({ error: "The session has ended" }); return; }
  if (!token) { res.status(403).json({ error: "Player token required" }); return; }
  const idx = await getPlayerIndexForToken(gameId, token);
  if (idx === null || idx === undefined || !state.players[idx] ||
      idx === (state.hostIsSpectator === true ? -1 : 0)) {
    res.status(403).json({ error: "Invalid player token" });
    return;
  }

  const player = state.players[idx];
  const questions = [...(state.questions ?? [])];
  // One open question per player at a time.
  const alreadyOpen = questions.some((q) => q.playerId === player.id && !q.resolved);
  if (alreadyOpen) { res.status(409).json({ error: "You already have a question waiting — the facilitator will get to it!" }); return; }

  questions.push({
    id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    playerId: player.id,
    playerName: player.name,
    text: (text ?? "").trim().slice(0, 300),
    ts: Date.now(),
    resolved: false,
  });
  const newState: GameState = { ...state, questions };
  await storeGame(newState);
  broadcast(gameId, newState);
  res.json({ ok: true });
});

// POST /api/games/:gameId/question/:questionId/resolve — facilitator clears a flag
router.post("/games/:gameId/question/:questionId/resolve", async (req, res) => {
  const { gameId, questionId } = req.params as { gameId: string; questionId: string };
  const { token } = req.body as { token?: string };

  const check = await requireHost(gameId, token, req.body?.userToken);
  if ("error" in check) { res.status(check.status).json({ error: check.error }); return; }

  const questions = (check.state.questions ?? []).map((q) =>
    q.id === questionId ? { ...q, resolved: true } : q
  );
  const state: GameState = { ...check.state, questions };
  await storeGame(state);
  broadcast(gameId, state);
  res.json(serializeState(state, check.hostIndex));
});

// POST /api/games/:gameId/end — facilitator ends the session for everyone
router.post("/games/:gameId/end", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token } = req.body as { token?: string };

  const check = await requireHost(gameId, token, req.body?.userToken);
  if ("error" in check) { res.status(check.status).json({ error: check.error }); return; }
  if (check.state.phase === "game_over") { res.status(409).json({ error: "Game is already over" }); return; }
  const state: GameState = {
    ...check.state,
    phase: "game_over",
    endedByHost: true,
    endedAt: Date.now(),
    paused: false,
    pendingDecision: null,
  };
  state.log = [...state.log.slice(-49), "🏁 The facilitator ended the session."];
  logEvent("game_ended_by_host", { gameId, metadata: { turnNumber: state.turnNumber, players: state.players.length } });
  await storeGame(state);
  broadcast(gameId, state);
  res.json(serializeState(state, check.hostIndex));
});

/**
 * Build a sensible decisionData for the facilitator stepping in on a stuck
 * decision. Skips when the decision is optional; otherwise picks the first
 * valid option(s). Never reveals hidden hand info to the facilitator — the
 * choice is made server-side.
 */
function buildAutoResolveData(decision: NonNullable<GameState["pendingDecision"]>): Record<string, unknown> {
  const opts = (decision.options ?? []) as any[];
  const meta = (decision.meta ?? {}) as Record<string, unknown>;
  switch (decision.type) {
    case "choose_rot_roulette_keep":
      return { keepCardIds: opts.slice(0, (meta.keepCount as number) ?? 2).map((o) => o.cardId) };
    case "choose_discard_for_spread":
    case "choose_discard_to_limit":
      return { cardIds: opts.slice(0, (meta.count as number) ?? 1).map((o) => o.cardId) };
    case "choose_rot_regrow_discard":
      return { cardIds: opts.slice(0, 3).map((o) => o.cardId) };
    case "choose_rainstorm_play":
      return { cardIds: [] };
    case "choose_target_player":
    case "choose_opponent_for_steal":
    case "choose_swap_opponent_breezy": {
      const o = opts[0];
      return { targetPlayerId: o?.targetPlayerId ?? o?.playerId, targetCardId: o?.targetCardId };
    }
    case "choose_function":
    case "choose_move_function":
      return { function: opts[0]?.function };
    default:
      if (meta.optional === true || opts.some((o) => o?.skip)) return { skip: true };
      if (opts[0] && typeof opts[0] === "object") return { ...opts[0] };
      return { skip: true };
  }
}

// POST /api/games/:gameId/facilitator-resolve — host resolves a stuck decision
router.post("/games/:gameId/facilitator-resolve", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token } = req.body as { token?: string };

  const check = await requireHost(gameId, token, req.body?.userToken);
  if ("error" in check) { res.status(check.status).json({ error: check.error }); return; }

  const state = check.state;
  const decision = state.pendingDecision;
  if (!decision) { res.status(409).json({ error: "There is no pending decision to resolve" }); return; }

  const owner = state.players.find((p) => p.id === decision.playerId);
  const data = buildAutoResolveData(decision);
  const result = resolveDecision(state, decision.playerId, data);
  if (result.error) { res.status(400).json({ error: result.error }); return; }

  let newState = result.state;
  newState.log = [...newState.log.slice(-49), `🛟 The facilitator stepped in and resolved ${owner?.name ?? "a player"}'s pending choice.`];
  newState = { ...runBotTurnsIfNeeded(newState), lastMeaningfulActivityAt: Date.now() };
  await storeGame(newState);
  broadcast(gameId, newState);
  logEvent("facilitator_resolve", { gameId, metadata: { decisionType: decision.type, ownerName: owner?.name } });
  res.json(serializeState(newState, check.hostIndex));
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

  // Facilitated: while paused, no game actions are allowed (facilitator
  // assist endpoints remain available).
  if (state.mode === "facilitated" && state.paused) {
    res.status(409).json({ error: "The facilitator has paused the game" });
    return;
  }

  // Once a game is over (naturally or ended by the facilitator), only a
  // reset can touch it — no further gameplay mutations.
  if (state.phase === "game_over" && type !== "reset_game") {
    res.status(409).json({ error: "The game is over" });
    return;
  }
  const linkedEvent = await getEventForGame(gameId);
  if (linkedEvent && type === "reset_game" &&
      (linkedEvent.status === "completed" || state.phase === "game_over")) {
    res.status(409).json({ error: "Finished event tables cannot be reset" });
    return;
  }

  // Multiplayer (online/facilitated): the acting player must present a valid
  // token, and it must belong to the playerId they claim to act as.
  if (state.mode === "online" || state.mode === "facilitated") {
    const tokenIndex = token ? await getPlayerIndexForToken(gameId, token) : null;
    if (tokenIndex === null || tokenIndex === undefined) {
      res.status(403).json({ error: "A valid player token is required for this game" });
      return;
    }
    const facilitatorReset = state.mode === "facilitated" && type === "reset_game";
    if (state.mode === "facilitated" &&
        tokenIndex === (state.hostIsSpectator === true ? -1 : 0) &&
        !facilitatorReset) {
      res.status(403).json({ error: "The facilitator host cannot perform player gameplay actions" });
      return;
    }
    const tokenPlayerId = state.players[tokenIndex]?.id;
    if (!facilitatorReset && (!tokenPlayerId || tokenPlayerId !== playerId)) {
      res.status(403).json({ error: "Token does not match the acting player" });
      return;
    }
  }

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
        if (state.mode === "facilitated") {
          const user = await getRegisteredUser(req.body?.userToken);
          const seat = token ? await getPlayerIndexForToken(gameId, token) : null;
          const expectedHostIndex = state.hostIsSpectator === true ? -1 : 0;
          if (seat !== expectedHostIndex || !isApprovedFacilitator(user) || user?.id !== state.facilitatorId) {
            res.status(403).json({ error: "Facilitator approval is required to reset this session" });
            return;
          }
        }
        const playerNames = state.players.map((p) => p.name);
        const botIndices = state.players
          .map((p, i) => ((p as any).isBot ? i : -1))
          .filter((i) => i >= 0);
        const botSkillLevels: Record<number, BotSkillLevel> = {};
        state.players.forEach((p, i) => {
          if ((p as any).isBot && (p as any).botSkillLevel) {
            botSkillLevels[i] = (p as any).botSkillLevel;
          }
        });
        // Reuse the same gameId so the URL and React Query cache stay valid
        let newState = createGameState(gameId, playerNames, state.mode, botIndices, botSkillLevels);
        // Player credentials and client state are bound to these IDs. A reset
        // starts fresh gameplay but must keep each identity in the same seat.
        newState.players = newState.players.map((player, index) => ({
          ...player,
          id: state.players[index].id,
        }));
        // Preserve facilitator/session metadata across resets so the room
        // stays on its creator's dashboard.
        newState.facilitatorId = state.facilitatorId;
        newState.eventId = state.eventId;
        newState.createdAt = state.createdAt;
        newState.label = state.label;
        newState.maxPlayers = state.maxPlayers;
        if (state.hostIsSpectator === true) newState.hostIsSpectator = true;
        newState = runBotTurnsIfNeeded(newState);
        await storeGame(newState);
        broadcast(newState.gameId, newState);
        res.json(serializeState(newState, state.hostIsSpectator === true ? -1 : 0));
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

  // Run bot turns/decisions FIRST, then build the facilitated announcement over
  // the FULL transition (pre-action → after bots) so viewers see the completed
  // effect — not just the human's intermediate step of a bot-completed chain.
  let stateAfterBots = { ...runBotTurnsIfNeeded(result.state), lastMeaningfulActivityAt: Date.now() };

  // Rich effect announcements were built for facilitated mode but are
  // spectator-safe (no hidden hand contents), so every mode gets them.
  {
    if (
      type === "play_card" ||
      type === "resolve_decision" ||
      type === "activate_ongoing" ||
      type === "move_card_layer"
    ) {
      // Resolve the originating card across all zones of both states — during
      // decision chains it may already have moved (e.g. into a compost pile).
      const effectCardId =
        type === "resolve_decision" ? state.pendingDecision?.cardId :
        type === "activate_ongoing" ? state.ongoingActionCard?.id :
        cardId;
      const effectCard = findEffectCard(state, stateAfterBots, effectCardId);
      const announcement = buildEffectAnnouncement(state, stateAfterBots, effectCard, playerId);
      stateAfterBots = { ...stateAfterBots, lastEffect: announcement };
    } else if ((type === "end_turn" || type === "draw_card") && stateAfterBots !== result.state) {
      // Bots took autonomous turns after this action. If a bot played an action
      // card, attribute the announcement to it (newest card in the discard pile
      // or a newly set ongoing card); otherwise announce the overall outcome.
      const beforeDiscard = new Set(result.state.discardPile.map((c) => c.id));
      const botCard =
        stateAfterBots.discardPile.find((c) => !beforeDiscard.has(c.id) && c.type === "action") ??
        (stateAfterBots.ongoingActionCard &&
        stateAfterBots.ongoingActionCard.id !== result.state.ongoingActionCard?.id
          ? stateAfterBots.ongoingActionCard
          : null);
      if (botCard) {
        const botActor =
          result.state.players[result.state.currentPlayerIndex]?.isBot
            ? result.state.players[result.state.currentPlayerIndex].id
            : playerId;
        const announcement = buildEffectAnnouncement(result.state, stateAfterBots, botCard, botActor);
        if (announcement) stateAfterBots = { ...stateAfterBots, lastEffect: announcement };
      }
    }
    // otherwise: keep the last announcement visible until the next effect
  }

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

// POST /api/games/:gameId/waiting/reorder — facilitator rearranges waiting seats
router.post("/games/:gameId/waiting/reorder", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token, playerIds } = req.body as {
    token?: string;
    userToken?: string;
    playerIds?: string[];
  };
  const check = await requireHost(gameId, token, req.body?.userToken);
  if ("error" in check) { res.status(check.status).json({ error: check.error }); return; }
  if (!Array.isArray(playerIds) || playerIds.some((id) => typeof id !== "string") ||
      new Set(playerIds).size !== playerIds.length) {
    res.status(400).json({ error: "playerIds must be a unique array of player IDs" });
    return;
  }
  const state = await reorderWaitingPlayers(gameId, playerIds);
  if (!state) {
    res.status(409).json({ error: "Room changed or playerIds do not exactly match its waiting participants" });
    return;
  }
  broadcast(gameId, state);
  res.json(serializeState(state, check.hostIndex));
});

// POST /api/games/:gameId/waiting/transfer — move a waiting participant to a
// different waiting room owned by this same approved facilitator.
router.post("/games/:gameId/waiting/transfer", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token, playerId, targetGameId } = req.body as {
    token?: string;
    userToken?: string;
    playerId?: string;
    targetGameId?: string;
  };
  if (!playerId || !targetGameId) {
    res.status(400).json({ error: "playerId and targetGameId are required" });
    return;
  }
  const outcome = await withGameMutationLocks([gameId, targetGameId], async () => {
    const check = await requireHost(gameId, token, req.body?.userToken);
    if ("error" in check) return { check, result: null };
    return { check, result: await transferWaitingPlayer(gameId, targetGameId, playerId) };
  });
  if ("error" in outcome.check) {
    res.status(outcome.check.status).json({ error: outcome.check.error });
    return;
  }
  if (!outcome.result) {
    res.status(409).json({ error: "Player could not be transferred; verify both rooms are waiting sessions with available space" });
    return;
  }
  // Deliver the reconnect instruction before dropping the old event stream.
  sendRoomTransferEvent(gameId, outcome.result.token, targetGameId, outcome.result.token);
  broadcast(gameId, outcome.result.source);
  broadcast(targetGameId, outcome.result.target);
  res.json({ success: true });
});

// DELETE /api/games/:gameId/players/:playerId — leave or kick
router.delete("/games/:gameId/players/:playerId", async (req, res) => {
  const { gameId, playerId } = req.params as { gameId: string; playerId: string };
  const { token, userToken } = req.body as { token?: string; userToken?: string };

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
  const hostIndex = state.mode === "facilitated"
    ? (state.hostIsSpectator === true ? -1 : 0)
    : 0;
  const isHost = requesterIndex === hostIndex;

  if (state.mode === "facilitated") {
    if (isHost) {
      if (isSelf) {
        res.status(403).json({ error: "The facilitator cannot leave through the player endpoint" });
        return;
      }
      const user = await getRegisteredUser(userToken);
      if (!user || !isApprovedFacilitator(user) || user.id !== state.facilitatorId) {
        res.status(403).json({ error: "Facilitator approval is required" });
        return;
      }
      if (state.phase === "game_over") {
        res.status(409).json({ error: "Cannot kick players from an ended session" });
        return;
      }
      if (target.isBot) {
        res.status(400).json({ error: "Bots cannot be kicked" });
        return;
      }

      const result = await kickFacilitatedPlayer(gameId, playerId, token, user.id);
      if (!result) {
        res.status(409).json({ error: "The room or host seat changed; refresh and try again" });
        return;
      }
      if (result.removedToken) sendKickedEvent(gameId, result.removedToken);
      broadcastToGame(gameId, result.state, serializeState);
      res.json({ success: true });
      return;
    }

    if (!isSelf) {
      res.status(403).json({ error: "Only the host can kick other players" });
      return;
    }
    if (state.phase !== "waiting") {
      res.status(409).json({ error: "Players can only leave during the waiting phase" });
      return;
    }
  } else if (!isSelf && !isHost) {
    res.status(403).json({ error: "Only the host can kick other players" });
    return;
  }

  if (state.eventId) {
    const result = await removeEventWaitingPlayer(gameId, playerId);
    if (!result) {
      res.status(409).json({ error: "Event seat changed; refresh and try again" });
      return;
    }
    if (result.removedToken) sendKickedEvent(gameId, result.removedToken);
    broadcast(gameId, result.state);
    res.json({ success: true });
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
