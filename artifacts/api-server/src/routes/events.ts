import { randomBytes, randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  CreateFacilitatorEventBody, GetFacilitatorEventsResponse, GetFacilitatorEventResponse,
  UpdateFacilitatorEventBody, UpdateFacilitatorEventResponse, ControlFacilitatorEventBody,
  ControlFacilitatorEventResponse, ControlFacilitatorEventTableBody,
  ControlFacilitatorEventTableResponse, GetPublicEventResponse, JoinEventBody,
  JoinEventResponse, SetEventReadyBody, SetEventReadyResponse,
  HeartbeatEventPresenceBody, HeartbeatEventPresenceResponse,
} from "@workspace/api-zod";
import {
  addPlayerToRoom, createWaitingRoom, launchGame, type GameState,
} from "../lib/gameEngine.js";
import { WIN_FUNCTIONS } from "../lib/cards.js";
import {
  broadcastToGame, createGameId, getEventForGame, getGame,
  isEventGameReadyToStart, lockGameMutationInTransaction,
  onGameBroadcast, updateGameStateCache, withGameMutationLocks,
} from "../lib/gameStore.js";
import { getUserByToken, isApprovedFacilitator } from "../lib/userStore.js";
import { serializeState } from "./game.js";

const router: IRouter = Router();
const streams = new Map<string, Set<(data: unknown) => void>>();
const uuid = () => randomUUID();
const createCode = () => randomBytes(6).toString("base64url").toUpperCase();
const normalizeCode = (code: string) => code.toUpperCase();
const parseState = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as GameState;

async function eventRecord(eventId: string) {
  const result = await pool.query(
    `SELECT id, code, facilitator_id, name, status, assignment_mode, idle_seconds,
            EXTRACT(EPOCH FROM last_meaningful_activity_at) * 1000 AS last_activity
       FROM compost_events WHERE id = $1`, [eventId],
  );
  return result.rows[0] as any;
}
async function tableRecords(eventId: string) {
  return (await pool.query(
    `SELECT game_id, table_number, capacity FROM compost_event_tables
     WHERE event_id = $1 ORDER BY table_number`, [eventId],
  )).rows as Array<{ game_id: string; table_number: number; capacity: number }>;
}
async function requireHost(eventId: string, userToken: unknown) {
  const user = typeof userToken === "string" ? await getUserByToken(userToken) : null;
  if (!user) return { failure: 401, error: "Sign in required" } as const;
  if (!isApprovedFacilitator(user)) return { failure: 403, error: "Facilitator approval is required" } as const;
  const event = await eventRecord(eventId);
  if (!event) return { failure: 404, error: "Event not found" } as const;
  if (event.facilitator_id !== user.id) return { failure: 403, error: "You are not the approved creator of this event" } as const;
  return { event, user } as const;
}
function pushEvent(eventId: string, payload: unknown) {
  for (const send of streams.get(eventId) ?? []) send(payload);
}

async function buildDetail(eventId: string, includeTokens = false) {
  const event = await eventRecord(eventId);
  if (!event) return null;
  const tables = await tableRecords(eventId);
  const seats = (await pool.query(
    `SELECT game_id, player_id, ready, last_seen_at FROM compost_event_seats WHERE event_id = $1`,
    [eventId],
  )).rows as Array<{ game_id: string; player_id: string; ready: boolean; last_seen_at: Date | null }>;
  const summaries = [];
  for (const table of tables) {
    const state = await getGame(table.game_id);
    if (!state) continue;
    const guestSeats = seats.filter((s) => s.game_id === table.game_id);
    const guestById = new Map(guestSeats.map((s) => [s.player_id, s]));
    const players = state.players.map((player) => {
      const seat = guestById.get(player.id);
      return {
        playerId: player.id,
        playerName: player.name,
        ready: seat?.ready === true,
        connected: !!seat?.last_seen_at && Date.now() - new Date(seat.last_seen_at).getTime() <= 45_000,
      };
    }).filter((p) => guestById.has(p.playerId));
    const questions = (state.questions ?? []).map(({ playerName, text, ts, resolved }) => ({ playerName, text, ts, resolved }));
    const pendingDecisionOwner = state.pendingDecision
      ? state.players.find((p) => p.id === state.pendingDecision?.playerId)?.name ?? null : null;
    const activityAt = (state as any).lastMeaningfulActivityAt ?? event.last_activity;
    const inactive = ["draw", "play", "effect_resolution", "end_turn"].includes(state.phase) &&
      !state.paused && Date.now() - Number(activityAt) > event.idle_seconds * 1000;
    const rank = (reason: string) => ({ help: 0, disconnected: 1, pending_decision: 2, inactive: 3 }[reason] ?? 4);
    const attention = [
      ...(questions.some((q: any) => !q.resolved) ? ["help"] : []),
      ...(players.some((p) => !p.connected) && players.length > 0 ? ["disconnected"] : []),
      ...(pendingDecisionOwner ? ["pending_decision"] : []),
      ...(inactive ? ["inactive"] : []),
    ].sort((a, b) => rank(a) - rank(b));
    summaries.push({
      gameId: table.game_id,
      tableNumber: table.table_number,
      capacity: table.capacity,
      phase: state.phase,
      paused: state.paused === true,
      players,
      progress: Math.max(0, ...state.players.map((player) => new Set(
        player.compostPile
          .map((card) => card.chosenFunction ?? card.function)
          .filter((fn) => WIN_FUNCTIONS.includes(fn as (typeof WIN_FUNCTIONS)[number])),
      ).size)),
      currentTurnPlayerName: state.players[state.currentPlayerIndex]?.name ?? null,
      winner: state.winner ? state.players.find((p) => p.id === state.winner)?.name ?? null : null,
      pendingDecisionOwner,
      questions,
      lastMeaningfulActivityAt: activityAt == null ? null : Number(activityAt),
      attention,
      message: state.hostMessage?.text ?? null,
    });
  }
  const detail: any = {
    eventId: event.id, code: event.code, name: event.name, status: event.status,
    assignmentMode: event.assignment_mode,
    idleSeconds: event.idle_seconds, tableCount: tables.length, tables: summaries,
  };
  if (includeTokens) {
    const hostTokens: Record<string, string> = {};
    for (const table of tables) {
      const row = await pool.query(
        `SELECT token FROM compost_game_tokens WHERE game_id = $1 AND player_index = -1 LIMIT 1`,
        [table.game_id],
      );
      if (row.rows[0]) hostTokens[table.game_id] = row.rows[0].token;
    }
    detail.hostTokens = hostTokens;
  }
  return detail;
}

onGameBroadcast((gameId) => {
  void pool.query(`SELECT event_id FROM compost_event_tables WHERE game_id = $1`, [gameId])
    .then(async (result) => {
      for (const row of result.rows) {
        const tables = await tableRecords(row.event_id);
        const states = await Promise.all(tables.map((table) => getGame(table.game_id)));
        if (states.length && states.every((state) => state?.phase === "game_over")) {
          await pool.query(`UPDATE compost_events SET status='completed' WHERE id=$1`, [row.event_id]);
        } else if (states.some((state) => state && state.phase !== "waiting" && state.phase !== "game_over")) {
          await pool.query(`UPDATE compost_events SET status='active' WHERE id=$1 AND status='upcoming'`, [row.event_id]);
        }
        pushEvent(row.event_id, await buildDetail(row.event_id));
      }
    }).catch(() => undefined);
});

router.get("/facilitator/events", async (req, res): Promise<void> => {
  const user = typeof req.query.userToken === "string" ? await getUserByToken(req.query.userToken) : null;
  if (!user) { res.status(401).json({ error: "Sign in required" }); return; }
  if (!isApprovedFacilitator(user)) { res.status(403).json({ error: "Facilitator approval is required" }); return; }
  const rows = (await pool.query(
    `SELECT e.id, e.code, e.name, e.status, e.idle_seconds,
            e.assignment_mode,
            (SELECT COUNT(*) FROM compost_event_tables t WHERE t.event_id = e.id) AS table_count
       FROM compost_events e WHERE e.facilitator_id = $1 ORDER BY e.created_at DESC`, [user.id],
  )).rows;
  res.json(GetFacilitatorEventsResponse.parse(rows.map((r) => ({ eventId: r.id, code: r.code, name: r.name, status: r.status, assignmentMode: r.assignment_mode, idleSeconds: r.idle_seconds, tableCount: Number(r.table_count) }))));
});

router.post("/facilitator/events", async (req, res): Promise<void> => {
  const body = req.body as { userToken?: string; name?: string; tableCount?: number; tableCapacities?: number[]; idleSeconds?: number; assignmentMode?: "choose" | "auto" };
  const parsedBody = CreateFacilitatorEventBody.safeParse(body);
  if (!parsedBody.success) { res.status(400).json({ error: parsedBody.error.message }); return; }
  const user = typeof body.userToken === "string" ? await getUserByToken(body.userToken) : null;
  if (!user) { res.status(401).json({ error: "Sign in required" }); return; }
  if (!isApprovedFacilitator(user)) { res.status(403).json({ error: "Facilitator approval is required" }); return; }
  const name = body.name?.trim();
  const count = Number(body.tableCount);
  const capacities = body.tableCapacities ?? Array(count).fill(4);
  const idleSeconds = body.idleSeconds ?? 120;
  if (!name || name.length > 100 || !Number.isInteger(count) || count < 1 || count > 10 ||
      capacities.length !== count || capacities.some((n) => !Number.isInteger(n) || n < 2 || n > 4) ||
      !Number.isInteger(idleSeconds) || idleSeconds < 30 || idleSeconds > 3600) {
    res.status(400).json({ error: "Invalid event name, table capacities, count, or idle threshold" }); return;
  }
  const eventId = uuid();
  let code = createCode();
  const client = await pool.connect();
  const newStates: GameState[] = [];
  try {
    await client.query("BEGIN");
    for (let attempt = 0; attempt < 4; attempt++) {
      const exists = await client.query(`SELECT 1 FROM compost_events WHERE code = $1`, [code]);
      if (!exists.rows.length) break;
      code = createCode();
    }
    await client.query(
     `INSERT INTO compost_events (id, code, facilitator_id, name, status, assignment_mode, idle_seconds)
       VALUES ($1,$2,$3,$4,'upcoming',$5,$6)`, [eventId, code, user.id, name, body.assignmentMode ?? "auto", idleSeconds],
    );
    for (let i = 0; i < count; i++) {
      const gameId = createGameId();
      const state = createWaitingRoom(gameId, `Table ${i + 1}`, capacities[i], "facilitated", true);
      state.createdAt = Date.now();
      state.facilitatorId = user.id;
      state.eventId = eventId;
      const token = randomBytes(32).toString("base64url");
      await client.query(
        `INSERT INTO compost_games (game_id, state, updated_at) VALUES ($1,$2,NOW())`,
        [gameId, JSON.stringify(state)],
      );
      await client.query(
        `INSERT INTO compost_game_tokens (game_id, token, player_index) VALUES ($1,$2,-1)`,
        [gameId, token],
      );
      await client.query(
        `INSERT INTO compost_event_tables (id,event_id,game_id,table_number,capacity) VALUES ($1,$2,$3,$4,$5)`,
        [uuid(), eventId, gameId, i + 1, capacities[i]],
      );
      newStates.push(state);
    }
    await client.query("COMMIT");
    newStates.forEach(updateGameStateCache);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  res.status(201).json(GetFacilitatorEventResponse.parse(await buildDetail(eventId, true)));
});

router.get("/facilitator/events/:eventId", async (req, res): Promise<void> => {
  const check = await requireHost(req.params.eventId, req.query.userToken);
  if ("failure" in check) { res.status(Number(check.failure)).json({ error: check.error }); return; }
  res.json(GetFacilitatorEventResponse.parse(await buildDetail(req.params.eventId, true)));
});

router.patch("/facilitator/events/:eventId", async (req, res): Promise<void> => {
  const body = req.body as { userToken?: string; name?: string; idleSeconds?: number; assignmentMode?: "choose" | "auto" };
  const parsedBody = UpdateFacilitatorEventBody.safeParse(body);
  if (!parsedBody.success) { res.status(400).json({ error: parsedBody.error.message }); return; }
  const check = await requireHost(req.params.eventId, body.userToken);
  if ("failure" in check) { res.status(Number(check.failure)).json({ error: check.error }); return; }
  if (body.name !== undefined && (!body.name.trim() || body.name.trim().length > 100)) { res.status(400).json({ error: "Event name must be 1-100 characters" }); return; }
  if (body.idleSeconds !== undefined && (!Number.isInteger(body.idleSeconds) || body.idleSeconds < 30 || body.idleSeconds > 3600)) { res.status(400).json({ error: "idleSeconds must be between 30 and 3600" }); return; }
  await pool.query(`UPDATE compost_events SET name = COALESCE($2,name), idle_seconds = COALESCE($3,idle_seconds), assignment_mode = COALESCE($4,assignment_mode) WHERE id = $1`,
    [req.params.eventId, body.name?.trim() ?? null, body.idleSeconds ?? null, body.assignmentMode ?? null]);
  const detail = await buildDetail(req.params.eventId, true);
  pushEvent(req.params.eventId, detail);
  res.json(UpdateFacilitatorEventResponse.parse(detail));
});

async function changeTable(gameId: string, action: string, text?: string) {
  try {
    return await withGameMutationLocks([gameId], async () => {
      const event = await getEventForGame(gameId);
      if (event && action !== "end" && ["ending", "completed"].includes(event.status)) {
        return { gameId, success: false, error: "Event is ending or has ended" };
      }
      const state = await getGame(gameId);
      if (!state) return { gameId, success: false, error: "Game not found" };
      let next = state;
      if (action === "start") {
        if (state.phase === "game_over") return { gameId, success: true, error: null };
        if (event && !await isEventGameReadyToStart(gameId)) {
          return { gameId, success: false, error: "Table needs at least two seated, ready, connected guests" };
        }
        const launched = launchGame(state);
        if (launched.error) return { gameId, success: false, error: launched.error };
        next = { ...launched.state, lastMeaningfulActivityAt: Date.now() } as GameState;
      } else if (action === "pause" || action === "pause_all") {
        if (state.phase === "game_over") return { gameId, success: true, error: null };
        next = { ...state, paused: true };
      } else if (action === "resume" || action === "resume_all") {
        if (state.phase === "game_over") return { gameId, success: true, error: null };
        next = { ...state, paused: false };
      } else if (action === "end") {
        if (state.phase === "game_over") return { gameId, success: true, error: null };
        next = { ...state, phase: "game_over", endedByHost: true, endedAt: Date.now(), paused: false, pendingDecision: null };
      } else if (action === "message") {
        if (state.phase === "game_over") return { gameId, success: true, error: null };
        const message = text?.trim();
        if (!message) return { gameId, success: false, error: "Message text is required" };
        next = { ...state, hostMessage: { id: uuid(), text: message.slice(0, 300), ts: Date.now() } };
      }
      if (next !== state) {
        await pool.query(`UPDATE compost_games SET state = $2, updated_at = NOW() WHERE game_id = $1`, [gameId, JSON.stringify(next)]);
        updateGameStateCache(next);
        broadcastToGame(gameId, next, serializeState);
      }
      return { gameId, success: true, error: null };
    });
  } catch (error) {
    return { gameId, success: false, error: error instanceof Error ? error.message : "Control failed" };
  }
}

router.post("/facilitator/events/:eventId/control", async (req, res): Promise<void> => {
  const body = req.body as { userToken?: string; action?: string; text?: string };
  const parsedBody = ControlFacilitatorEventBody.safeParse(body);
  if (!parsedBody.success) { res.status(400).json({ error: parsedBody.error.message }); return; }
  const check = await requireHost(req.params.eventId, body.userToken);
  if ("failure" in check) { res.status(Number(check.failure)).json({ error: check.error }); return; }
  if (["ending", "completed"].includes(check.event.status) && body.action !== "end") { res.status(409).json({ error: "Event is ending or has ended" }); return; }
  const action = body.action ?? "";
  if (!["start", "pause_all", "resume_all", "end", "message"].includes(action)) { res.status(400).json({ error: "Invalid event action" }); return; }
  if (action === "message" && !body.text?.trim()) { res.status(400).json({ error: "Message text is required" }); return; }
  if (action === "end" && check.event.status !== "completed") {
    await pool.query(`UPDATE compost_events SET status='ending' WHERE id=$1 AND status <> 'completed'`, [req.params.eventId]);
  }
  const tables = await tableRecords(req.params.eventId);
  const results = [];
  for (const table of tables) {
    results.push(await changeTable(table.game_id, action, body.text));
  }
  if (action === "start") {
    const states = await Promise.all(tables.map((table) => getGame(table.game_id)));
    const startedAny = states.some((state) => !!state && state.phase !== "waiting" && state.phase !== "game_over");
    if (startedAny) {
      await pool.query(`UPDATE compost_events SET status='active' WHERE id=$1 AND status IN ('upcoming','active')`, [req.params.eventId]);
      await pool.query(`UPDATE compost_events SET last_meaningful_activity_at=NOW() WHERE id=$1`, [req.params.eventId]);
    }
  }
  if (action === "end" && results.every((r) => r.success)) {
    await pool.query(`UPDATE compost_events SET status='completed' WHERE id=$1`, [req.params.eventId]);
  }
  pushEvent(req.params.eventId, await buildDetail(req.params.eventId));
  res.json(ControlFacilitatorEventResponse.parse({ eventId: req.params.eventId, action, results }));
});

router.post("/facilitator/events/:eventId/tables/:gameId/control", async (req, res): Promise<void> => {
  const body = req.body as { userToken?: string; action?: string; text?: string };
  const parsedBody = ControlFacilitatorEventTableBody.safeParse(body);
  if (!parsedBody.success) { res.status(400).json({ error: parsedBody.error.message }); return; }
  const check = await requireHost(req.params.eventId, body.userToken);
  if ("failure" in check) { res.status(Number(check.failure)).json({ error: check.error }); return; }
  if (["ending", "completed"].includes(check.event.status)) { res.status(409).json({ error: "Event is ending or has ended" }); return; }
  const table = (await tableRecords(req.params.eventId)).find((t) => t.game_id === req.params.gameId);
  if (!table) { res.status(404).json({ error: "Table not found" }); return; }
  if (!["pause", "resume", "message"].includes(body.action ?? "")) { res.status(400).json({ error: "Invalid table action" }); return; }
  if (body.action === "message" && !body.text?.trim()) { res.status(400).json({ error: "Message text is required" }); return; }
  const result = await changeTable(req.params.gameId, body.action!, body.text);
  pushEvent(req.params.eventId, await buildDetail(req.params.eventId));
  res.json(ControlFacilitatorEventTableResponse.parse(result));
});

router.get("/facilitator/events/:eventId/stream", async (req, res): Promise<void> => {
  const check = await requireHost(req.params.eventId, req.query.userToken);
  if ("failure" in check) { res.status(Number(check.failure)).json({ error: check.error }); return; }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const write = (data: unknown) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };
  write(await buildDetail(req.params.eventId));
  const eventId = req.params.eventId;
  if (!streams.has(eventId)) streams.set(eventId, new Set());
  streams.get(eventId)!.add(write);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => { clearInterval(ping); streams.get(eventId)?.delete(write); });
});

router.get("/events/:code", async (req, res): Promise<void> => {
  const row = (await pool.query(`SELECT id,code,name,status,assignment_mode FROM compost_events WHERE code=$1`, [normalizeCode(req.params.code)])).rows[0];
  if (!row) { res.status(404).json({ error: "Event not found" }); return; }
  const tables = await tableRecords(row.id);
  const result = [];
  for (const table of tables) {
    const state = await getGame(table.game_id);
    result.push({ tableNumber: table.table_number, capacity: table.capacity, occupied: (state?.players.length ?? 0) });
  }
  res.json(GetPublicEventResponse.parse({ code: row.code, name: row.name, status: row.status, assignmentMode: row.assignment_mode, tables: result }));
});

router.post("/events/:code/join", async (req, res): Promise<void> => {
  const { name, tableNumber, existingToken } = req.body as { name?: string; tableNumber?: number; existingToken?: string };
  const parsedBody = JoinEventBody.safeParse(req.body);
  if (!parsedBody.success) { res.status(400).json({ error: parsedBody.error.message }); return; }
  const event = (await pool.query(`SELECT * FROM compost_events WHERE code=$1`, [normalizeCode(req.params.code)])).rows[0];
  if (!event) { res.status(404).json({ error: "Event not found" }); return; }
  const tables = await tableRecords(event.id);
  if (existingToken) {
    const owned = await pool.query(
      `SELECT t.game_id,t.table_number,tok.player_index,g.state FROM compost_game_tokens tok
       JOIN compost_event_tables t ON t.game_id=tok.game_id
       JOIN compost_games g ON g.game_id=t.game_id
       WHERE tok.token=$1 AND t.event_id=$2`, [existingToken, event.id],
    );
    if (owned.rows[0]) {
      const row = owned.rows[0];
      const state = parseState(row.state);
      const player = Number(row.player_index) >= 0 ? state.players[Number(row.player_index)] : undefined;
      const registeredSeat = player && await pool.query(
        `SELECT 1 FROM compost_event_seats WHERE game_id=$1 AND player_id=$2`,
        [row.game_id, player.id],
      );
      if (player && registeredSeat?.rows.length) {
        res.json(JoinEventResponse.parse({ gameId: row.game_id, token: existingToken, playerId: player.id, playerName: player.name, tableNumber: row.table_number }));
        return;
      }
    }
    res.status(403).json({ error: "Invalid event seat token" }); return;
  }
  const trimmed = name?.trim();
  if (!trimmed || trimmed.length > 60) { res.status(400).json({ error: "Name must be 1-60 characters" }); return; }
  if (!["upcoming", "active"].includes(event.status)) { res.status(409).json({ error: "Event is not accepting new joins" }); return; }
  if (event.assignment_mode === "auto" && tableNumber !== undefined) {
    res.status(400).json({ error: "tableNumber is not allowed for auto-assignment events" }); return;
  }
  if (tableNumber !== undefined && (!Number.isInteger(tableNumber) || !tables.some((t) => t.table_number === tableNumber))) {
    res.status(400).json({ error: "Invalid tableNumber" }); return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const gameId of tables.map((table) => table.game_id).sort()) {
      await lockGameMutationInTransaction(client, gameId);
    }
    const lockedEvent = await client.query(`SELECT status,assignment_mode FROM compost_events WHERE id=$1 FOR UPDATE`, [event.id]);
    if (!lockedEvent.rows.length || !["upcoming", "active"].includes(lockedEvent.rows[0].status)) {
      await client.query("ROLLBACK"); res.status(409).json({ error: "Event is not accepting new joins" }); return;
    }
    if (lockedEvent.rows[0].assignment_mode === "auto" && tableNumber !== undefined) {
      await client.query("ROLLBACK"); res.status(400).json({ error: "tableNumber is not allowed for auto-assignment events" }); return;
    }
    const snapshots = [];
    for (const table of tables) {
      const row = await client.query(`SELECT state FROM compost_games WHERE game_id=$1 FOR UPDATE`, [table.game_id]);
      if (row.rows[0]) snapshots.push({ table, state: parseState(row.rows[0].state) });
    }
    const countMap = new Map(snapshots.map(({ table, state }) => [table.game_id, state.players.length]));
    const eligible = snapshots.filter(({ table, state }) =>
      (tableNumber == null || table.table_number === tableNumber) &&
      state.phase === "waiting" && (countMap.get(table.game_id) ?? 0) < table.capacity
    ).sort((a, b) =>
      (countMap.get(a.table.game_id) ?? 0) - (countMap.get(b.table.game_id) ?? 0) ||
      a.table.table_number - b.table.table_number
    );
    if (!eligible.length) {
      await client.query("ROLLBACK"); res.status(409).json({ error: "No available seats at the selected table" }); return;
    }
    const { table, state } = eligible[0];
    const joined = addPlayerToRoom(state, trimmed);
    if ("error" in joined) {
      await client.query("ROLLBACK"); res.status(409).json({ error: joined.error }); return;
    }
    const player = joined.state.players[joined.state.players.length - 1];
    const token = randomBytes(32).toString("base64url");
    await client.query(`UPDATE compost_games SET state=$2,updated_at=NOW() WHERE game_id=$1`, [table.game_id, JSON.stringify(joined.state)]);
    await client.query(`INSERT INTO compost_game_tokens(game_id,token,player_index) VALUES($1,$2,$3)`,
      [table.game_id, token, joined.state.players.length - 1]);
    await client.query(
      `INSERT INTO compost_event_seats(id,event_id,game_id,player_id,player_index,ready,last_seen_at)
       VALUES($1,$2,$3,$4,$5,false,NOW())`,
      [uuid(), event.id, table.game_id, player.id, joined.state.players.length - 1],
    );
    await client.query("COMMIT");
    updateGameStateCache(joined.state);
    broadcastToGame(table.game_id, joined.state, serializeState);
    pushEvent(event.id, await buildDetail(event.id));
    res.status(201).json(JoinEventResponse.parse({ gameId: table.game_id, token, playerId: player.id, playerName: player.name, tableNumber: table.table_number }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
});

async function resolveEventSeat(code: string, token: unknown) {
  if (typeof token !== "string" || !token) return null;
  const row = (await pool.query(
    `SELECT e.id AS event_id,e.status AS event_status,t.game_id,t.table_number,tok.player_index
       FROM compost_events e JOIN compost_event_tables t ON t.event_id=e.id
       JOIN compost_game_tokens tok ON tok.game_id=t.game_id
       WHERE e.code=$1 AND tok.token=$2`, [normalizeCode(code), token],
  )).rows[0];
  if (!row || Number(row.player_index) < 0) return null;
  const state = await getGame(row.game_id);
  const player = state?.players[Number(row.player_index)];
  if (!player) return null;
  const seat = await pool.query(
    `SELECT 1 FROM compost_event_seats WHERE game_id=$1 AND player_id=$2`, [row.game_id, player.id],
  );
  if (!seat.rows.length) return null;
  return { ...row, player_id: player.id, token, playerIndex: Number(row.player_index) };
}

router.post("/events/:code/ready", async (req, res): Promise<void> => {
  const body = req.body as { token?: string; ready?: boolean };
  const parsedBody = SetEventReadyBody.safeParse(body);
  if (!parsedBody.success) { res.status(400).json({ error: parsedBody.error.message }); return; }
  const seat = await resolveEventSeat(req.params.code, body.token);
  if (!seat) { res.status(403).json({ error: "Invalid event seat token" }); return; }
  const result = await withGameMutationLocks([seat.game_id], async () => {
    const refreshed = await resolveEventSeat(req.params.code, body.token);
    if (!refreshed) return { status: 403, error: "Invalid event seat token" };
    if (["ending", "completed"].includes(refreshed.event_status)) return { status: 409, error: "Event is ending or has ended" };
    await pool.query(`UPDATE compost_event_seats SET ready=$3 WHERE game_id=$1 AND player_id=$2`,
      [refreshed.game_id, refreshed.player_id, body.ready === true]);
    pushEvent(refreshed.event_id, await buildDetail(refreshed.event_id));
    return { status: 200 };
  });
  if (result.status !== 200) { res.status(result.status).json({ error: result.error }); return; }
  res.json(SetEventReadyResponse.parse({ ok: true }));
});

router.post("/events/:code/presence", async (req, res): Promise<void> => {
  const parsedBody = HeartbeatEventPresenceBody.safeParse(req.body);
  if (!parsedBody.success) { res.status(400).json({ error: parsedBody.error.message }); return; }
  const seat = await resolveEventSeat(req.params.code, parsedBody.data.token);
  if (!seat) { res.status(403).json({ error: "Invalid event seat token" }); return; }
  await withGameMutationLocks([seat.game_id], async () => {
    const refreshed = await resolveEventSeat(req.params.code, parsedBody.data.token);
    if (!refreshed) return;
    await pool.query(`UPDATE compost_event_seats SET last_seen_at=NOW() WHERE game_id=$1 AND player_id=$2`, [refreshed.game_id, refreshed.player_id]);
    pushEvent(refreshed.event_id, await buildDetail(refreshed.event_id));
  });
  res.json(HeartbeatEventPresenceResponse.parse({ ok: true }));
});

export default router;