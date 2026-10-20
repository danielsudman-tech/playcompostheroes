import { Router, type IRouter } from "express";
import "./../lib/turnTimerRuntime.js";
import { buildAutoResolveData } from "../lib/autoResolve.js";
import { validTurnTimer } from "../lib/turnClock.js";
import { coverHumanSeat, resetMissedTurns, returnCoveredSeat } from "../lib/playerCover.js";
import { revokeSeatTokens, withClientTransaction } from "../lib/gameStore.js";
import { addSystemUpdate } from "../lib/systemUpdates.js";
import { pool } from "@workspace/db";
import { logEvent } from "../lib/analyticsStore.js";
import { markFirstHumanTurn } from "../lib/gameAnalytics.js";
import { restartFinishedGame } from "../lib/gameReplay.js";
import {
  activateOngoing,
  addBotToRoom,
  addPlayerToRoom,
  createGameState,
  createWaitingRoom,
  captureEngineOperations,
  drawCardAction,
  endTurn,
  launchGame,
  mergeEngineOperationTraces,
  moveCardLayer,
  playCard,
  removePlayerFromRoom,
  resolveDecision,
  runBotTurnsIfNeeded,
  drainBotDecisions,
  type BotSkillLevel,
  type EngineOperationTrace,
  type GameState,
} from "../lib/gameEngine.js";
import { getAllCards } from "../lib/cards.js";
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
  getConnectedPlayerIds,
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
  releaseGameMutationLockSafely,
  withGameMutationLocks,
  type PgClient,
  type PgQueryable,
} from "../lib/gameStore.js";
import { getEventTriviaEnabled } from "../lib/eventTriviaSettings.js";
import { buildEffectAnnouncement, findEffectCard, serializeEffectAnnouncement } from "../lib/facilitatedEffects.js";
import { sanitizeRecapLog } from "../lib/recapPrivacy.js";
import { extractBearerToken, getUserByToken, isApprovedFacilitator, type CompostUser } from "../lib/userStore.js";

// Registration rules: online games (and facilitated hosting) require a
// registered account. Facilitated participants and Pass & Play never do.
async function getRegisteredUser(userToken: unknown, client?: PgQueryable): Promise<CompostUser | null> {
  if (typeof userToken !== "string" || !userToken.trim()) return null;
  try {
    return await getUserByToken(userToken, client);
  } catch {
    return null;
  }
}

async function requireRegisteredUser(userToken: unknown, client?: PgQueryable): Promise<boolean> {
  return (await getRegisteredUser(userToken, client)) !== null;
}

const router: IRouter = Router();

function requestClient(req: unknown): PgClient | undefined {
  return (req as { gameMutationClient?: PgClient }).gameMutationClient;
}

// Every game mutation shares the timer/event advisory lock and held client.
// Transfers take their own ordered two-game locks.
router.use("/games/:gameId", (req, res, next) => {
  if (req.method === "GET" || req.originalUrl.includes("/waiting/transfer")) return next();
  void (async () => {
    const gameId = req.params.gameId;
    const isEnd = req.originalUrl.split("?")[0].endsWith("/end");
    const client = await acquireGameMutationLock(gameId);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await releaseGameMutationLockSafely(client, gameId);
    };
    const reportReleaseFailure = (error: unknown) => {
      try {
        const errorCode = error && typeof error === "object"
          ? (error as { code?: unknown }).code
          : undefined;
        const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*Error$/.test(error.name)
          ? error.name
          : "Error";
        console.error(JSON.stringify({
          level: "error",
          event: "game_mutation_lock_release_failed",
          errorName,
          errorCode: typeof errorCode === "string" && /^[A-Z0-9]{5}$/.test(errorCode) ? errorCode : undefined,
        }));
      } catch { /* cleanup logging must never create an unhandled rejection */ }
    };
    try {
      const event = await getEventForGame(gameId, client);
      if (event && ["ending", "completed"].includes(event.status) && !isEnd) {
        await release();
        res.status(409).json({ error: "Event is ending or has ended" });
        return;
      }
      const originalEnd = res.end.bind(res);
      (res as any).end = (...args: any[]) => {
        const result = originalEnd(...args);
        void release().catch(reportReleaseFailure);
        return result;
      };
      res.once("close", () => {
        if (res.writableFinished) void release().catch(reportReleaseFailure);
      });
      (req as any).gameMutationClient = client;
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
  const { deck, analyticsRoundId: _analyticsRoundId, analyticsFirstTurnCompletedAt: _analyticsFirstTurn, turnTimerActorKey: _timerActorKey, turnSequence: _turnSequence, botUpdateSequence: _botSequence, systemUpdateSequence: _systemSequence, ...rest } = state;
  const viewerId = viewerIndex !== undefined && viewerIndex >= 0
    ? state.players[viewerIndex]?.id
    : undefined;

  // Effect details about a discarded hand card are withheld from the shared
  // state and materialized only for the viewer who owns that hand.
  const lastEffect = serializeEffectAnnouncement(state.lastEffect, viewerId, isOnline);
  const knownCardNames = [
    ...getAllCards().map((card) => card.name),
    ...state.players.flatMap((player) => [
      ...player.hand.map((card) => card.name),
      ...player.compostPile.map((card) => card.name),
    ]),
    ...state.deck.map((card) => card.name),
    ...state.discardPile.map((card) => card.name),
    ...(state.ongoingActionCard ? [state.ongoingActionCard.name] : []),
  ];

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
  if (pendingDecision?.meta?.originActorId) {
    const { originActorId: _serverOnlyOriginActorId, ...publicMeta } = pendingDecision.meta;
    pendingDecision = {
      ...pendingDecision,
      meta: Object.keys(publicMeta).length > 0 ? publicMeta : undefined,
    };
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
    replayReadyPlayerIds: state.replayReadyPlayerIds ?? [],
    connectedPlayerIds: getConnectedPlayerIds(state.gameId),
    botTurnUpdates: state.botTurnUpdates ?? [],
    systemUpdates: state.systemUpdates ?? [],
    ...(state.eventId ? { triviaEnabled: getEventTriviaEnabled(state.eventId) } : {}),
    log: sanitizeRecapLog(state.log, knownCardNames),
    lastEffect,
    pendingDecision,
    questions,
    deckCount: deck.length,
    players: state.players.map((player, idx) => {
      const { lastMissedTurnNumber: _missedTurn, ...publicPlayer } = player;
      if (!isOnline || idx === viewerIndex) {
        return publicPlayer;
      }
      return { ...publicPlayer, hand: player.hand.map(() => HIDDEN_CARD) };
    }),
  };
}

// ─── Broadcast helper ────────────────────────────────────────────────────────

function broadcast(gameId: string, state: GameState, client?: PgClient) {
  broadcastToGame(gameId, state, serializeState, client);
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
  const { playerNames, mode, password, hostName, maxPlayers, botPlayerIndices, botSkillLevels, turnTimerSeconds = 0 } = req.body as {
    playerNames?: string[];
    mode: "facilitator" | "standalone" | "online" | "facilitated";
    password?: string;
    hostName?: string;
    maxPlayers?: number;
    botPlayerIndices?: number[];
    botSkillLevels?: Record<number, BotSkillLevel>;
    turnTimerSeconds?: number;
  };
  if (!validTurnTimer(turnTimerSeconds)) {
    res.status(400).json({ error: "Choose Off, 30, 60, 90, or 120 seconds" }); return;
  }

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
    state.turnTimerSeconds = turnTimerSeconds;
    const label = ((req.body as { label?: string }).label ?? "").trim();
    if (label) state.label = label.slice(0, 60);
    const creatorToken = await withGameMutationLocks([gameId], async client => {
      await storeGame(state, client);
      if (password && password.trim()) await setGamePassword(gameId, password.trim(), client);
      return mode === "facilitated" ? createSpectatorHostToken(gameId, client) : (await claimSlot(gameId, undefined, client))?.token ?? null;
    });
    logEvent("game_created", { gameId, metadata: { mode, maxPlayers: max, hostName: name } });

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
    res.status(404).json({ error: "This event has been removed" });
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
  const client = requestClient(req);

  const state = await getGame(gameId, client);
  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  if (await getEventForGame(gameId, client) && !existingToken) {
    res.status(409).json({ error: "Join this event through its event code" });
    return;
  }

  // New claims on online games require a registered account. Rejoining with
  // an existing game token stays open (the token already proves membership).
  if (state.mode === "online" && !existingToken && !(await requireRegisteredUser(userToken, client))) {
    res.status(401).json({ error: "Sign in required to join an online game" });
    return;
  }

  if (await gameHasPassword(gameId, client) && !existingToken) {
    if (!password) {
      res.status(403).json({ error: "This game is password protected", requiresPassword: true });
      return;
    }
    if (!await checkGamePassword(gameId, password, client)) {
      res.status(403).json({ error: "Incorrect password", requiresPassword: true });
      return;
    }
  }

  if (existingToken) {
    const tokenGameId = await getGameIdForToken(existingToken, client);
    if (!tokenGameId) {
      res.status(403).json({ error: "Invalid game token" });
      return;
    }
    if (tokenGameId !== gameId) {
      res.status(409).json({ redirectGameId: tokenGameId, targetToken: existingToken });
      return;
    }
  }

  const claimed = await claimSlot(gameId, existingToken, client);
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
  const client = requestClient(req);

  if (await getEventForGame(gameId, client)) {
    res.status(409).json({ error: "Join this event through its event code" });
    return;
  }

  const state = await getGame(gameId, client);
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
  if (state.mode === "online" && !(await requireRegisteredUser(userToken, client))) {
    res.status(401).json({ error: "Sign in required to join an online game" });
    return;
  }

  if (await gameHasPassword(gameId, client)) {
    if (!password) {
      res.status(403).json({ error: "This game is password protected", requiresPassword: true });
      return;
    }
    if (!await checkGamePassword(gameId, password, client)) {
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

  await storeGame(result.state, client);
  await logEvent("player_joined", { gameId, metadata: { playerName: trimmedName, playerCount: result.state.players.length } }, client);

  const claimed = await claimSlot(gameId, undefined, client);
  if (!claimed) {
    res.status(409).json({ error: "Failed to assign player slot" });
    return;
  }

  broadcastToGame(gameId, result.state, serializeState, client);

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
  const client = requestClient(req);

  let state = await getGame(gameId, client);
  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const viewerIndex = token
    ? (await getPlayerIndexForToken(gameId, token, client) ?? undefined)
    : undefined;
  if (state.mode === "facilitated") {
    if (viewerIndex !== (state.hostIsSpectator === true ? -1 : 0)) {
      res.status(403).json({ error: "Only the host can start the game" });
      return;
    }
    const user = await getRegisteredUser(req.body?.userToken, client);
    if (!isApprovedFacilitator(user) || user?.id !== state.facilitatorId) {
      res.status(403).json({ error: "Facilitator approval is required" });
      return;
    }
  } else if (viewerIndex !== 0) {
    res.status(403).json({ error: "Only the host can start the game" });
    return;
  }

  const event = await getEventForGame(gameId, client);
  if (event) {
    if (botSlots !== undefined) {
      res.status(400).json({ error: "Event tables cannot be started with bot slots" });
      return;
    }
    if (!await isEventGameReadyToStart(gameId, client)) {
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
  await storeGame(launchedState, client);
  broadcastToGame(gameId, launchedState, serializeState, client);

  res.json(serializeState(launchedState, viewerIndex));
});

// GET /api/games/:gameId/events — SSE real-time stream
router.get("/games/:gameId/events", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const token = req.query.token as string | undefined;
  if (!token) {
    res.status(400).json({ error: "token query param required" });
    return;
  }

  const sseWrite = (chunk: string) => {
    res.write(chunk);
    (res as any).flush?.();
  };

  let ping: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  req.on("close", () => {
    closed = true;
    clearInterval(ping);
    removeSseClient(gameId, token, res);
    // Read under the same lock as replay so a late disconnect cannot publish
    // an obsolete game_over snapshot after fresh hands have been dealt.
    void withGameMutationLocks([gameId], async client => {
      const current = await getGame(gameId, client);
      if (current?.phase === "game_over") broadcast(gameId, current, client);
    }).catch(error => console.error("[table presence] Failed to publish disconnect", error));
  });

  // Resolve the state, credential and stream seat atomically with seat mutations.
  // A reorder between separate reads must not expose the hand now at the old index.
  await withGameMutationLocks([gameId], async client => {
    const state = await getGame(gameId, client);
    if (closed) return;
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    const viewerIndex = await getPlayerIndexForToken(gameId, token, client);
    if (closed) return;
    if (viewerIndex === null || (viewerIndex !== -1 && !state.players[viewerIndex])) {
      res.status(403).json({ error: "Invalid token" });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    addSseClient(gameId, token, res, viewerIndex, state.players[viewerIndex]?.id);
    sseWrite(`data: ${JSON.stringify(serializeState(state, viewerIndex))}\n\n`);
    if (state.phase === "game_over") broadcast(gameId, state, client);
    ping = setInterval(() => {
      try { sseWrite(": ping\n\n"); } catch { clearInterval(ping); }
    }, 15000);
  });
});

// POST /api/games/:gameId/nudge — poke the current player when it's their turn
router.post("/games/:gameId/nudge", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token, targetPlayerIndex } = req.body as { token?: string; targetPlayerIndex?: number };
  const client = requestClient(req);

  if (!token || targetPlayerIndex === undefined) {
    res.status(400).json({ error: "token and targetPlayerIndex required" });
    return;
  }

  const state = await getGame(gameId, client);
  if (!state) { res.status(404).json({ error: "Game not found" }); return; }

  if (state.mode !== "online" && state.mode !== "facilitated") {
    res.status(400).json({ error: "Nudges are only available in multiplayer games" });
    return;
  }

  const senderIndex = await getPlayerIndexForToken(gameId, token, client);
  if (senderIndex === undefined || senderIndex === null) { res.status(403).json({ error: "Invalid token" }); return; }

  // Facilitated sessions: the reserved spectator (or legacy seat zero) may nudge.
  const hostIndex = state.hostIsSpectator === true ? -1 : 0;
  if (state.mode === "facilitated" && senderIndex !== hostIndex) {
    res.status(403).json({ error: "Only the facilitator (host) can nudge players" });
    return;
  }
  if (state.mode === "facilitated") {
    const user = await getRegisteredUser(req.body?.userToken, client);
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
  await sendNudgeEvent(gameId, target, senderName, client);
  res.json({ ok: true });
});

// ─── Facilitator (host = player index 0) assist controls ────────────────────

async function requireHost(gameId: string, token: string | undefined, userToken: unknown, client?: PgQueryable): Promise<{ state: GameState; hostIndex: number } | { status: number; error: string }> {
  const state = await getGame(gameId, client);
  if (!state) return { status: 404, error: "Game not found" };
  if (state.mode !== "facilitated") return { status: 400, error: "Facilitator controls are only available in facilitated games" };
  if (!token) return { status: 403, error: "Host token required" };
  const idx = await getPlayerIndexForToken(gameId, token, client);
  const hostIndex = state.hostIsSpectator === true ? -1 : 0;
  if (idx !== hostIndex) return { status: 403, error: "Only the facilitator (host) can do this" };
  const user = await getRegisteredUser(userToken, client);
  if (!isApprovedFacilitator(user) || user?.id !== state.facilitatorId) {
    return { status: 403, error: "Facilitator approval is required" };
  }
  return { state, hostIndex };
}

// POST /api/games/:gameId/pause — facilitator pauses/resumes the game
router.post("/games/:gameId/pause", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token, paused } = req.body as { token?: string; paused?: boolean };
  const client = requestClient(req);

  const check = await requireHost(gameId, token, req.body?.userToken, client);
  if ("error" in check) { res.status(check.status).json({ error: check.error }); return; }

  const state: GameState = { ...check.state, paused: paused === true };
  state.log = [...state.log.slice(-49), paused === true ? "⏸️ The facilitator paused the game." : "▶️ The facilitator resumed the game."];
  await storeGame(state, client);
  broadcast(gameId, state, client);
  res.json(serializeState(state, check.hostIndex));
});

// GET /api/facilitator/rooms — sessions created by the signed-in facilitator
router.get("/facilitator/rooms", async (req, res) => {
  const user = await getRegisteredUser(extractBearerToken(req.get("authorization")));
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
  const client = requestClient(req);
  const user = await getRegisteredUser((req.body as { userToken?: string }).userToken, client);
  if (!user) { res.status(401).json({ error: "Sign in required" }); return; }

  const state = await getGame(gameId, client);
  if (!state) { res.status(404).json({ error: "Game not found" }); return; }
  if (state.mode !== "facilitated" || state.facilitatorId !== user.id || !isApprovedFacilitator(user)) {
    res.status(403).json({ error: "You are not the facilitator of this session" });
    return;
  }
  const token = await getTokenForPlayerIndex(gameId, state.hostIsSpectator === true ? -1 : 0, client);
  if (!token) { res.status(404).json({ error: "Host seat token not found" }); return; }
  res.json({ token });
});

// POST /api/games/:gameId/message — facilitator broadcasts a message to all tables
router.post("/games/:gameId/message", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token, text } = req.body as { token?: string; text?: string };

  const client = requestClient(req);
  const check = await requireHost(gameId, token, req.body?.userToken, client);
  if ("error" in check) { res.status(check.status).json({ error: check.error }); return; }

  if (check.state.phase === "game_over") { res.status(409).json({ error: "The session has ended" }); return; }

  const trimmed = (text ?? "").trim();
  if (!trimmed) { res.status(400).json({ error: "Message text is required" }); return; }

  const state: GameState = {
    ...check.state,
    hostMessage: { id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, text: trimmed.slice(0, 300), ts: Date.now() },
  };
  state.log = [...state.log.slice(-49), `📢 Facilitator: ${trimmed.slice(0, 300)}`];
  await storeGame(state, client);
  broadcast(gameId, state, client);
  res.json(serializeState(state, check.hostIndex));
});

// POST /api/games/:gameId/question — participant flags a question for the facilitator
router.post("/games/:gameId/question", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token, text } = req.body as { token?: string; text?: string };

  const client = requestClient(req);
  const state = await getGame(gameId, client);
  if (!state) { res.status(404).json({ error: "Game not found" }); return; }
  if (state.mode !== "facilitated") { res.status(400).json({ error: "Questions are only available in facilitated games" }); return; }
  if (state.phase === "game_over") { res.status(409).json({ error: "The session has ended" }); return; }
  if (!token) { res.status(403).json({ error: "Player token required" }); return; }
  const idx = await getPlayerIndexForToken(gameId, token, client);
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
  await storeGame(newState, client);
  broadcast(gameId, newState, client);
  res.json({ ok: true });
});

// POST /api/games/:gameId/question/:questionId/resolve — facilitator clears a flag
router.post("/games/:gameId/question/:questionId/resolve", async (req, res) => {
  const { gameId, questionId } = req.params as { gameId: string; questionId: string };
  const { token } = req.body as { token?: string };

  const client = requestClient(req);
  const check = await requireHost(gameId, token, req.body?.userToken, client);
  if ("error" in check) { res.status(check.status).json({ error: check.error }); return; }

  const questions = (check.state.questions ?? []).map((q) =>
    q.id === questionId ? { ...q, resolved: true } : q
  );
  const state: GameState = { ...check.state, questions };
  await storeGame(state, client);
  broadcast(gameId, state, client);
  res.json(serializeState(state, check.hostIndex));
});

// POST /api/games/:gameId/end — facilitator ends the session for everyone
router.post("/games/:gameId/end", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token } = req.body as { token?: string };

  const client = requestClient(req);
  const check = await requireHost(gameId, token, req.body?.userToken, client);
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
  await logEvent("game_ended_by_host", { gameId, metadata: { turnNumber: state.turnNumber, players: state.players.length } }, client);
  await storeGame(state, client);
  broadcast(gameId, state, client);
  res.json(serializeState(state, check.hostIndex));
});

/**
 * Build a sensible decisionData for the facilitator stepping in on a stuck
 * decision. Skips when the decision is optional; otherwise picks the first
 * valid option(s). Never reveals hidden hand info to the facilitator — the
 * choice is made server-side.
 */
// POST /api/games/:gameId/facilitator-resolve — host resolves a stuck decision
router.post("/games/:gameId/facilitator-resolve", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const { token } = req.body as { token?: string };

  const client = requestClient(req);
  const check = await requireHost(gameId, token, req.body?.userToken, client);
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
  await storeGame(newState, client);
  broadcast(gameId, newState, client);
  await logEvent("facilitator_resolve", { gameId, metadata: { decisionType: decision.type, ownerName: owner?.name } }, client);
  res.json(serializeState(newState, check.hostIndex));
});

// POST /api/games/:gameId/action — perform a game action
router.post("/games/:gameId/action", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  const client = requestClient(req);
  const state = await getGame(gameId, client);
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
  // Coordination is allowed after finishing, including for a human whose seat
  // is temporarily bot-covered. It never grants permission to restart.
  if (type === "set_replay_ready") {
    const seat = token ? await getPlayerIndexForToken(gameId, token, client) : null;
    const player = seat != null && seat >= 0 ? state.players[seat] : undefined;
    if (!["online", "facilitated"].includes(state.mode) || !player ||
        player.id !== playerId || (player.isBot && !player.botCovering)) {
      res.status(403).json({ error: "A valid participant seat token is required" }); return;
    }
    const event = await getEventForGame(gameId, client);
    if (state.phase !== "game_over" || (event && ["ending", "completed"].includes(event.status))) {
      res.status(409).json({ error: "Readiness is only available after a round in an open room" }); return;
    }
    if (typeof req.body.ready !== "boolean" || !Number.isInteger(req.body.roundNumber)) {
      res.status(400).json({ error: "ready and roundNumber are required" }); return;
    }
    if (req.body.roundNumber !== (state.roundNumber ?? 1)) {
      res.status(409).json({ error: "The round has changed" }); return;
    }
    const ready = new Set(state.replayReadyPlayerIds ?? []);
    if (req.body.ready) ready.add(player.id); else ready.delete(player.id);
    const next = { ...state, replayReadyPlayerIds: [...ready] };
    await storeGame(next, client);
    broadcast(gameId, next, client);
    res.json(serializeState(next, seat!)); return;
  }
  if (type === "set_turn_timer") {
    const index = token ? await getPlayerIndexForToken(gameId, token, client) : null;
    const user = await getRegisteredUser(req.body?.userToken, client);
    const seconds = req.body?.data?.turnTimerSeconds;
    if (state.mode !== "online" || index !== 0 || !user || user.id !== state.facilitatorId) {
      res.status(403).json({ error: "Only the signed-in room host can change the timer" }); return;
    }
    if (state.phase !== "waiting") { res.status(409).json({ error: "Change the timer before starting" }); return; }
    if (!validTurnTimer(seconds)) { res.status(400).json({ error: "Invalid turn timer" }); return; }
    const next = { ...state, turnTimerSeconds: seconds };
    await storeGame(next, client);
    broadcast(gameId, next, client);
    res.json(serializeState(next, 0)); return;
  }
  if (type === "take_back_seat") {
    const seat = token ? await getPlayerIndexForToken(gameId, token, client) : null;
    const player = seat != null ? state.players[seat] : undefined;
    if (!player || player.id !== playerId || !player.botCovering) {
      res.status(403).json({ error: "A valid token for your covered seat is required" }); return;
    }
    if (state.phase === "waiting" || state.phase === "game_over") {
      res.status(409).json({ error: "This game is not in progress" }); return;
    }
    const next = returnCoveredSeat(state, playerId);
    await storeGame(next, client);
    broadcast(gameId, next, client);
    res.json(serializeState(next, seat!)); return;
  }
  if (type === "cover_player" || type === "remove_player") {
    const seat = token ? await getPlayerIndexForToken(gameId, token, client) : null;
    const user = await getRegisteredUser(req.body?.userToken, client);
    if (state.mode !== "online" || seat !== 0 || !user || user.id !== state.facilitatorId || playerId !== state.players[0]?.id) {
      res.status(403).json({ error: "Only the signed-in room host can manage other seats" }); return;
    }
    if (state.phase === "waiting" || state.phase === "game_over") {
      res.status(409).json({ error: "Seat cover and replacement are only available during a game" }); return;
    }
    const targetId = req.body?.data?.playerId;
    const index = state.players.findIndex(p => p.id === targetId);
    const target = state.players[index];
    if (!target || index === 0 || (target.isBot && !target.botCovering)) {
      res.status(400).json({ error: "Choose another human or temporarily covered seat" }); return;
    }
    if (type === "cover_player" && target.botCovering) {
      res.status(409).json({ error: "A bot is already covering this player" }); return;
    }
    if (!client) throw new Error("Seat management requires the held game mutation client");
    let next = coverHumanSeat(state, target.id, type === "cover_player");
    next = { ...next, log: [...next.log, type === "cover_player"
      ? `A bot is covering for ${target.name}.`
      : `${target.name} was removed from the game and permanently replaced by a bot.`] };
    if (type === "remove_player") next = addSystemUpdate(next, `${target.name} was removed from the game and permanently replaced by a bot.`);
    next = runBotTurnsIfNeeded(resetMissedTurns(next, playerId));
    let removedTokens: string[] = [];
    await withClientTransaction(client, async () => {
      if (type === "remove_player") removedTokens = await revokeSeatTokens(gameId, index, client);
      await storeGame(next, client);
    });
    for (const removed of removedTokens) sendKickedEvent(gameId, removed);
    broadcast(gameId, next, client);
    res.json(serializeState(next, 0)); return;
  }
  if (state.turnTimerSeconds && type !== "reset_game" && req.body?.turnDeadlineKey !== state.turnDeadlineKey) {
    res.status(409).json({ error: "The turn or choice changed. Use the current table controls." }); return;
  }

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
  const linkedEvent = await getEventForGame(gameId, client);
  if (linkedEvent && type === "reset_game" &&
      ["ending", "completed"].includes(linkedEvent.status)) {
    res.status(409).json({ error: "This event is ending or has ended" });
    return;
  }

  // Multiplayer (online/facilitated): the acting player must present a valid
  // token, and it must belong to the playerId they claim to act as.
  if (state.mode === "online" || state.mode === "facilitated") {
    const tokenIndex = token ? await getPlayerIndexForToken(gameId, token, client) : null;
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
    if (type !== "reset_game" && state.players[tokenIndex]?.isBot) {
      res.status(409).json({ error: "A bot is covering this seat. Take your seat back first." }); return;
    }
    if (!facilitatorReset && (!tokenPlayerId || tokenPlayerId !== playerId)) {
      res.status(403).json({ error: "Token does not match the acting player" });
      return;
    }
  }

  let result: { state: typeof state; error?: string };
  let effectOperations: EngineOperationTrace | undefined;

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
        const captured = captureEngineOperations(
          state,
          () => playCard(state, playerId, cardId),
          { playedCardId: cardId },
        );
        result = captured.result;
        effectOperations = captured.trace;
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
        const pendingDecision = state.pendingDecision;
        const captured = captureEngineOperations(
          state,
          () => resolveDecision(state, playerId, data),
          {
            playedCardId: pendingDecision?.meta?.rotRoulettePlay ? data.cardId as string : undefined,
          },
        );
        result = captured.result;
        effectOperations = captured.trace;
        break;
      }
      case "activate_ongoing": {
        const captured = captureEngineOperations(
          state,
          () => activateOngoing(state, playerId),
        );
        result = captured.result;
        effectOperations = captured.trace;
        break;
      }
      case "move_card_layer": {
        if (!cardId) {
          res.status(400).json({ error: "cardId required for move_card_layer" });
          return;
        }
        const targetFunction = (req.body as any).targetFunction as string | undefined;
        const captured = captureEngineOperations(
          state,
          () => moveCardLayer(state, playerId, cardId, targetFunction),
          { playedCardId: cardId },
        );
        result = captured.result;
        effectOperations = captured.trace;
        break;
      }
      case "reset_game": {
        if (state.mode === "facilitated" || state.mode === "online") {
          const user = await getRegisteredUser(req.body?.userToken, client);
          const seat = token ? await getPlayerIndexForToken(gameId, token, client) : null;
          const expectedHostIndex = state.hostIsSpectator === true ? -1 : 0;
          if (seat !== expectedHostIndex || !user || user.id !== state.facilitatorId ||
              (state.mode === "facilitated" && !isApprovedFacilitator(user))) {
            res.status(403).json({ error: "Only the room host can start another round" });
            return;
          }
        }
        if (state.phase !== "game_over") {
          res.status(409).json({ error: "Finish the current round before playing again" }); return;
        }
        if (state.players.length < 2) {
          res.status(409).json({ error: "At least two players are needed to start another round" }); return;
        }
        const newState = restartFinishedGame(state);
        await storeGame(newState, client);
        broadcast(newState.gameId, newState, client);
        const viewer = token ? await getPlayerIndexForToken(gameId, token, client) : undefined;
        res.json(serializeState(newState, viewer ?? undefined));
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
  result.state = resetMissedTurns(result.state, playerId);
  const victimDecisions = captureEngineOperations(result.state, () => ({ state: drainBotDecisions(result.state) }));
  const humanEffectState = victimDecisions.result.state;
  const botOperationsCapture = captureEngineOperations(
    humanEffectState,
    () => ({ state: runBotTurnsIfNeeded(humanEffectState) }),
  );
  const botOperations = botOperationsCapture.trace;
  const announcementOperations = mergeEngineOperationTraces(effectOperations, victimDecisions.trace);
  let stateAfterBots = {
    ...botOperationsCapture.result.state,
    lastMeaningfulActivityAt: Date.now(),
  };

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
      const pendingOriginVerb = state.pendingDecision?.meta?.originVerb;
      const storedOriginActorId = state.pendingDecision?.meta?.originActorId;
      const effectActorId =
        type === "resolve_decision"
          ? typeof storedOriginActorId === "string" &&
            state.players.some((player) => player.id === storedOriginActorId)
            ? storedOriginActorId
            : state.players[state.currentPlayerIndex]?.id ?? playerId
          : playerId;
      const verb = type === "activate_ongoing"
        ? "activated"
        : type === "move_card_layer"
          ? "moved"
          : type === "resolve_decision" &&
              (pendingOriginVerb === "activated" || pendingOriginVerb === "moved")
            ? pendingOriginVerb
            : "played";
      const announcement = buildEffectAnnouncement(
        state,
        humanEffectState,
        effectCard,
        effectActorId,
        verb,
        announcementOperations,
      );
      stateAfterBots = { ...stateAfterBots, lastEffect: announcement };
    } else if ((type === "end_turn" || type === "draw_card") && stateAfterBots !== result.state) {
      // Bots took autonomous turns after this action. If a bot played an action
      // card, attribute the announcement to it (newest card in the discard pile
      // or a newly set ongoing card); otherwise announce the overall outcome.
      const actualPlay = botOperations.plays?.at(-1);
      const botCard = actualPlay?.card;
      if (botCard) {
        const botActor = actualPlay!.playerId;
        const botActivatedOngoing =
          stateAfterBots.ongoingBenefitUsedThisTurn &&
          !result.state.ongoingBenefitUsedThisTurn &&
          stateAfterBots.ongoingActionCard?.id === botCard?.id;
        const announcement = buildEffectAnnouncement(
          result.state,
          stateAfterBots,
          botCard,
          botActor,
          botActivatedOngoing ? "activated" : "played",
          botOperations,
        );
        if (announcement) stateAfterBots = { ...stateAfterBots, lastEffect: announcement };
      }
    }
    // otherwise: keep the last announcement visible until the next effect
  }

  markFirstHumanTurn(state, stateAfterBots, playerId);
  await storeGame(stateAfterBots, client);
  broadcast(gameId, stateAfterBots, client);

  const viewerIndex =
    token ? (await getPlayerIndexForToken(gameId, token, client) ?? undefined) : undefined;
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
  const client = requestClient(req);
  const check = await requireHost(gameId, token, req.body?.userToken, client);
  if ("error" in check) { res.status(check.status).json({ error: check.error }); return; }
  if (!Array.isArray(playerIds) || playerIds.some((id) => typeof id !== "string") ||
      new Set(playerIds).size !== playerIds.length) {
    res.status(400).json({ error: "playerIds must be a unique array of player IDs" });
    return;
  }
  const state = await reorderWaitingPlayers(gameId, playerIds, client);
  if (!state) {
    res.status(409).json({ error: "Room changed or playerIds do not exactly match its waiting participants" });
    return;
  }
  broadcast(gameId, state, client);
  res.json(serializeState(state, check.hostIndex));
});

// POST /api/games/:gameId/waiting/transfer — legacy path retained for compatible
// transfers before play or between rounds, within one open event or host's rooms.
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
  const outcome = await withGameMutationLocks([gameId, targetGameId], async (client) => {
    const check = await requireHost(gameId, token, req.body?.userToken, client);
    if ("error" in check) return { check, result: null };
    return { check, result: await transferWaitingPlayer(gameId, targetGameId, playerId, client) };
  });
  if ("error" in outcome.check) {
    res.status(outcome.check.status).json({ error: outcome.check.error });
    return;
  }
  if (!outcome.result) {
    res.status(409).json({ error: "Both tables must be waiting or finished, in the same open event (or standalone rooms you host), with space at the destination" });
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
  const client = requestClient(req);

  if (!token) {
    res.status(401).json({ error: "Token required" });
    return;
  }

  const state = await getGame(gameId, client);
  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const requesterIndex = await getPlayerIndexForToken(gameId, token, client);
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
      const user = await getRegisteredUser(userToken, client);
      if (!user || !isApprovedFacilitator(user) || user.id !== state.facilitatorId) {
        res.status(403).json({ error: "Facilitator approval is required" });
        return;
      }
      if (target.isBot && state.phase !== "game_over") {
        res.status(400).json({ error: "Bots cannot be kicked" });
        return;
      }

      const result = await kickFacilitatedPlayer(gameId, playerId, token, user.id, client);
      if (!result) {
        res.status(409).json({ error: "The room or host seat changed; refresh and try again" });
        return;
      }
      if (result.removedToken) sendKickedEvent(gameId, result.removedToken);
      broadcastToGame(gameId, result.state, serializeState, client);
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

  const linkedEvent = await getEventForGame(gameId, client);
  if (state.eventId || linkedEvent) {
    const result = await removeEventWaitingPlayer(gameId, playerId, client);
    if (!result) {
      res.status(409).json({ error: "Event seat changed; refresh and try again" });
      return;
    }
    if (result.removedToken) sendKickedEvent(gameId, result.removedToken);
    broadcast(gameId, result.state, client);
    res.json({ success: true });
    return;
  }

  const result = removePlayerFromRoom(state, playerId);
  if ("error" in result) {
    res.status(400).json({ error: result.error });
    return;
  }

  const removedToken = await removePlayerTokenByIndex(gameId, result.removedIndex, client);

  if (removedToken) {
    sendKickedEvent(gameId, removedToken);
  }

  await storeGame(result.state, client);

  if (result.state.players.length > 0) {
    broadcast(gameId, result.state, client);
  }

  res.json({ success: true });
});

export default router;
