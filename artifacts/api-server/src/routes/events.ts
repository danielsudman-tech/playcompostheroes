import { randomBytes, randomUUID } from "node:crypto";
import { syncTurnClock, validTurnTimer } from "../lib/turnClock.js";
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  CreateFacilitatorEventBody, GetFacilitatorEventsResponse, GetFacilitatorEventResponse,
  UpdateFacilitatorEventBody, UpdateFacilitatorEventResponse, ControlFacilitatorEventBody,
  ControlFacilitatorEventResponse, ControlFacilitatorEventTableBody,
  ControlFacilitatorEventTableResponse, GetEventReadyResponse, GetPublicEventResponse, JoinEventBody,
  JoinEventResponse, SetEventReadyBody, SetEventReadyResponse,
  HeartbeatEventPresenceBody, HeartbeatEventPresenceResponse,
  CreateFacilitatorEventStreamTicketBody, CreateFacilitatorEventStreamTicketResponse,
} from "@workspace/api-zod";
import {
  addPlayerToRoom, createWaitingRoom, launchGame, type GameState,
} from "../lib/gameEngine.js";
import { WIN_FUNCTIONS } from "../lib/cards.js";
import {
  broadcastToGame, createGameId, getEventForGame, getGame,
  getCachedGameState,
  invalidateGameCaches, isEventGameReadyToStart, readTokenSlotConsistently,
  onGameBroadcast, updateGameStateCache, withGameMutationLocks, withClientTransaction,
  type PgClient, type PgQueryable,
} from "../lib/gameStore.js";
import {
  beginEventTriviaRead, finishEventTriviaRead, forgetEventTriviaEnabled,
  setEventTriviaEnabled, setEventTriviaEnabledIfCurrent,
} from "../lib/eventTriviaSettings.js";
import { extractBearerToken, getUserByToken, isApprovedFacilitator } from "../lib/userStore.js";
import {
  consumeEventStreamTicket, issueEventStreamTicket, revokeEventStreamTickets,
} from "../lib/eventStreamTickets.js";
import {
  EVENT_PRESENCE_SWEEP_INTERVAL_MS, EventPresenceSweepCursor,
  updateEventPresenceAndPublishTransition,
} from "../lib/eventPresence.js";
import { serializeState } from "./game.js";
import { EventDetailCoalescer, loadHostTokens } from "../lib/eventDashboard.js";
import {
  acquireDatabaseClient,
  asDatabaseSafeguardError,
  classifyDatabaseSafeguardError,
  DatabaseSafeguardError,
} from "../lib/databaseSafeguards.js";

const router: IRouter = Router();
const streams = new Map<string, Set<(data: unknown) => void>>();
const uuid = () => randomUUID();
const createCode = () => randomBytes(6).toString("base64url").toUpperCase();
const normalizeCode = (code: string) => code.toUpperCase();
const parseState = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as GameState;
async function eventCodeIsPresent(code: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM compost_events WHERE code=$1`,
    [normalizeCode(code)],
  );
  return result.rows.length > 0;
}

async function eventRecord(eventId: string, client: PgQueryable = pool) {
  const triviaRead = beginEventTriviaRead(eventId);
  try {
    const result = await client.query(
      `SELECT id, code, facilitator_id, name, status, assignment_mode, idle_seconds, trivia_enabled, turn_timer_seconds,
              EXTRACT(EPOCH FROM last_meaningful_activity_at) * 1000 AS last_activity
         FROM compost_events WHERE id = $1`, [eventId],
    );
    const event = result.rows[0] as any;
    if (event) setEventTriviaEnabledIfCurrent(triviaRead, event.trivia_enabled !== false);
    return event;
  } finally {
    finishEventTriviaRead(triviaRead);
  }
}
async function tableRecords(eventId: string, client: PgQueryable = pool) {
  return (await client.query(
    `SELECT game_id, table_number, capacity FROM compost_event_tables
     WHERE event_id = $1 ORDER BY table_number`, [eventId],
  )).rows as Array<{ game_id: string; table_number: number; capacity: number }>;
}
async function requireHost(eventId: string, userToken: unknown, client?: PgQueryable) {
  const user = typeof userToken === "string" ? await getUserByToken(userToken, client) : null;
  if (!user) return { failure: 401, error: "Sign in required" } as const;
  if (!isApprovedFacilitator(user)) return { failure: 403, error: "Facilitator approval is required" } as const;
  const event = await eventRecord(eventId, client);
  if (!event) return { failure: 404, error: "Event not found" } as const;
  if (event.facilitator_id !== user.id) return { failure: 403, error: "You are not the approved creator of this event" } as const;
  return { event, user } as const;
}
function pushEvent(eventId: string, payload: unknown) {
  for (const send of streams.get(eventId) ?? []) send(payload);
}

async function buildDetail(eventId: string, includeTokens = false, client: PgQueryable = pool) {
  const triviaRead = beginEventTriviaRead(eventId);
  let eventTables;
  try {
    eventTables = await client.query(
      `SELECT e.id, e.code, e.name, e.status, e.assignment_mode, e.idle_seconds, e.trivia_enabled, e.turn_timer_seconds,
              EXTRACT(EPOCH FROM e.last_meaningful_activity_at) * 1000 AS last_activity,
              t.game_id, t.table_number, t.capacity
         FROM compost_events e
         LEFT JOIN compost_event_tables t ON t.event_id = e.id
        WHERE e.id = $1
        ORDER BY t.table_number`,
      [eventId],
    );
  } catch (error) {
    finishEventTriviaRead(triviaRead);
    throw error;
  }
  if (!eventTables.rows.length) {
    finishEventTriviaRead(triviaRead);
    return null;
  }
  const event = eventTables.rows[0];
  setEventTriviaEnabledIfCurrent(triviaRead, event.trivia_enabled !== false);
  finishEventTriviaRead(triviaRead);
  const tables = eventTables.rows
    .filter((row: any) => row.game_id != null)
    .map((row: any) => ({ game_id: row.game_id, table_number: row.table_number, capacity: row.capacity }));
  const seats = (await client.query(
    `SELECT game_id, player_id, ready, last_seen_at FROM compost_event_seats WHERE event_id = $1`,
    [eventId],
  )).rows as Array<{ game_id: string; player_id: string; ready: boolean; last_seen_at: Date | null }>;
  const summaries = [];
  const stateClient = client === pool ? undefined : client;
  const tableStates = await Promise.all(tables.map((table) => getGame(table.game_id, stateClient)));
  for (const [index, table] of tables.entries()) {
    const state = tableStates[index];
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
        lastSeenAt: seat?.last_seen_at == null ? null : new Date(seat.last_seen_at).getTime(),
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
    idleSeconds: event.idle_seconds, triviaEnabled: event.trivia_enabled !== false, turnTimerSeconds: event.turn_timer_seconds ?? 0,
    tableCount: tables.length, tables: summaries,
  };
  if (includeTokens) {
    detail.hostTokens = await loadHostTokens(client, tables.map((table) => table.game_id));
  }
  return detail;
}

const eventDetailCoalescer = new EventDetailCoalescer(
  (eventId) => (streams.get(eventId)?.size ?? 0) > 0,
  (eventId) => buildDetail(eventId),
  pushEvent,
  undefined,
  (error) => console.error("[event dashboard detail push]", error),
);
const enqueueEventDetail = (eventId: string) => eventDetailCoalescer.enqueue(eventId);

function notifyEventRemoved(eventId: string): void {
  eventDetailCoalescer.cancel(eventId);
  forgetEventTriviaEnabled(eventId);
  revokeEventStreamTickets(eventId);
  const subscribers = streams.get(eventId);
  streams.delete(eventId);
  for (const send of subscribers ?? []) {
    try { send({ eventRemoved: true }); } catch {}
  }
}

onGameBroadcast((gameId) => {
  void pool.query(
    `WITH phases AS (
       SELECT t.event_id, COUNT(*) AS table_count,
              BOOL_AND(g.state->>'phase' = 'game_over') AS all_completed,
              BOOL_OR(g.state->>'phase' NOT IN ('waiting', 'game_over')) AS any_active
         FROM compost_event_tables t
         JOIN compost_games g ON g.game_id = t.game_id
        WHERE EXISTS (
          SELECT 1 FROM compost_event_tables changed
           WHERE changed.event_id = t.event_id AND changed.game_id = $1
        )
        GROUP BY t.event_id
     ), status_update AS (
       UPDATE compost_events e
          SET status = CASE
            WHEN p.table_count > 0 AND p.all_completed THEN 'completed'
            WHEN p.any_active AND e.status = 'upcoming' THEN 'active'
            ELSE e.status
          END
         FROM phases p
        WHERE e.id = p.event_id
          AND ((p.table_count > 0 AND p.all_completed AND e.status <> 'completed')
            OR (p.any_active AND e.status = 'upcoming'))
       RETURNING e.id
     )
     SELECT event_id FROM phases`,
    [gameId],
  ).then((result) => {
    for (const row of result.rows) enqueueEventDetail(row.event_id);
  }).catch((error) => console.error("[event status broadcast]", error));
});

let presenceSweepInFlight = false;
const presenceSweepCursor = new EventPresenceSweepCursor();
async function sweepEventPresence() {
  if (presenceSweepInFlight) return;
  presenceSweepInFlight = true;
  try {
    await presenceSweepCursor.run(async (previousSuccessfulSweepAt) => {
      const sweep = await pool.query(
        `WITH sweep_clock AS MATERIALIZED (
           SELECT NOW() AS swept_at
         ), crossed AS (
           SELECT DISTINCT s.event_id
             FROM compost_event_seats s
             JOIN compost_events e ON e.id = s.event_id
             CROSS JOIN sweep_clock c
            WHERE e.status <> 'completed'
              AND s.last_seen_at < c.swept_at - INTERVAL '45 seconds'
              AND ($1::timestamptz IS NULL OR
                   s.last_seen_at > $1::timestamptz - INTERVAL '46 seconds')
         )
         SELECT c.swept_at, crossed.event_id
           FROM sweep_clock c LEFT JOIN crossed ON TRUE`,
        [previousSuccessfulSweepAt === null ? null : new Date(previousSuccessfulSweepAt)],
      );
      for (const row of sweep.rows) {
        if (row.event_id) enqueueEventDetail(row.event_id);
      }
      return new Date(sweep.rows[0].swept_at).getTime();
    });
  } catch {
    // Retain the previous successful cutoff so the next sweep retries this full interval.
  } finally {
    presenceSweepInFlight = false;
  }
}
const presenceSweepTimer = setInterval(() => { void sweepEventPresence(); }, EVENT_PRESENCE_SWEEP_INTERVAL_MS);
presenceSweepTimer.unref();

router.get("/facilitator/events", async (req, res): Promise<void> => {
  const userToken = extractBearerToken(req.get("authorization"));
  const user = userToken ? await getUserByToken(userToken) : null;
  if (!user) { res.status(401).json({ error: "Sign in required" }); return; }
  if (!isApprovedFacilitator(user)) { res.status(403).json({ error: "Facilitator approval is required" }); return; }
  const rows = (await pool.query(
    `SELECT e.id, e.code, e.name, e.status, e.idle_seconds,
             e.assignment_mode, e.trivia_enabled, e.turn_timer_seconds,
            (SELECT COUNT(*) FROM compost_event_tables t WHERE t.event_id = e.id) AS table_count
       FROM compost_events e WHERE e.facilitator_id = $1 ORDER BY e.created_at DESC`, [user.id],
  )).rows;
  res.json(GetFacilitatorEventsResponse.parse(rows.map((r) => ({ eventId: r.id, code: r.code, name: r.name, status: r.status, assignmentMode: r.assignment_mode, idleSeconds: r.idle_seconds, triviaEnabled: r.trivia_enabled !== false, turnTimerSeconds: r.turn_timer_seconds ?? 0, tableCount: Number(r.table_count) }))));
});

router.post("/facilitator/events", async (req, res): Promise<void> => {
  const body = req.body as { userToken?: string; name?: string; tableCount?: number; tableCapacities?: number[]; idleSeconds?: number; assignmentMode?: "choose" | "auto"; turnTimerSeconds?: number };
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
  const client = await acquireDatabaseClient(() => pool.connect(), "not-started");
  let clientDestroyed = false;
  let commitAttempted = false;
  let committed = false;
  const newStates: GameState[] = [];
  try {
    await client.query("BEGIN");
    for (let attempt = 0; attempt < 4; attempt++) {
      const exists = await client.query(`SELECT 1 FROM compost_events WHERE code = $1`, [code]);
      if (!exists.rows.length) break;
      code = createCode();
    }
    await client.query(
     `INSERT INTO compost_events (id, code, facilitator_id, name, status, assignment_mode, idle_seconds, turn_timer_seconds)
       VALUES ($1,$2,$3,$4,'upcoming',$5,$6,$7)`, [eventId, code, user.id, name, body.assignmentMode ?? "auto", idleSeconds, body.turnTimerSeconds ?? 0],
    );
    for (let i = 0; i < count; i++) {
      const gameId = createGameId();
      const state = createWaitingRoom(gameId, `Table ${i + 1}`, capacities[i], "facilitated", true);
      state.createdAt = Date.now();
      state.facilitatorId = user.id;
      state.eventId = eventId;
      state.turnTimerSeconds = body.turnTimerSeconds ?? 0;
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
    commitAttempted = true;
    await client.query("COMMIT");
    committed = true;
    setEventTriviaEnabled(eventId, true);
    newStates.forEach(updateGameStateCache);
  } catch (error) {
    let rollbackSucceeded = false;
    if (!committed) {
      try {
        await client.query("ROLLBACK");
        rollbackSucceeded = true;
      } catch (rollbackError) {
        clientDestroyed = true;
        client.release(rollbackError instanceof Error ? rollbackError : new Error("Transaction rollback failed"));
      }
    }
    throw asDatabaseSafeguardError(
      error,
      rollbackSucceeded && !commitAttempted ? "rolled-back" : "unknown",
    );
  } finally {
    if (!clientDestroyed) client.release();
  }
  res.status(201).json(GetFacilitatorEventResponse.parse(await buildDetail(eventId, true)));
});

router.get("/facilitator/events/:eventId", async (req, res): Promise<void> => {
  const check = await requireHost(req.params.eventId, extractBearerToken(req.get("authorization")));
  if ("failure" in check) { res.status(Number(check.failure)).json({ error: check.error }); return; }
  res.json(GetFacilitatorEventResponse.parse(await buildDetail(req.params.eventId, true)));
});

router.delete("/facilitator/events/:eventId", async (req, res): Promise<void> => {
  const eventId = req.params.eventId;
  const userToken = extractBearerToken(req.get("authorization"));
  const preflight = await requireHost(eventId, userToken);
  if ("failure" in preflight) {
    res.status(Number(preflight.failure)).json({ error: preflight.error });
    return;
  }
  if (preflight.event.status !== "completed") {
    res.status(409).json({ error: "Only completed events can be deleted" });
    return;
  }

  const initialTables = await tableRecords(eventId);
  if (!initialTables.length) {
    res.status(409).json({ error: "Event tables could not be verified as complete" });
    return;
  }
  const initialGameIds = initialTables.map((table) => table.game_id).sort();
  const sameGameIds = (tables: typeof initialTables) => {
    const gameIds = tables.map((table) => table.game_id).sort();
    return gameIds.length === initialGameIds.length &&
      gameIds.every((gameId, index) => gameId === initialGameIds[index]);
  };
  const outcome = await withGameMutationLocks(initialGameIds, async (client) => {
    const outcome = await withClientTransaction(client, async () => {
      await client.query(`SELECT id FROM compost_events WHERE id=$1 FOR UPDATE`, [eventId]);
      const check = await requireHost(eventId, userToken, client);
      if ("failure" in check) return { failure: Number(check.failure), error: check.error } as const;
      if (check.event.status !== "completed") {
        return { failure: 409, error: "Only completed events can be deleted" } as const;
      }

      const tables = await tableRecords(eventId, client);
      if (!sameGameIds(tables)) {
        return { failure: 409, error: "Event tables changed; refresh and retry" } as const;
      }
      const gameRows = await client.query(
        `SELECT game_id, state FROM compost_games
          WHERE game_id = ANY($1::text[])
          ORDER BY game_id
          FOR UPDATE`,
        [initialGameIds],
      );
      if (gameRows.rows.length !== initialGameIds.length ||
          gameRows.rows.some((row: any) => parseState(row.state).phase !== "game_over")) {
        return { failure: 409, error: "Every event table must be complete before the event can be deleted" } as const;
      }

      await client.query(
        `DELETE FROM compost_game_tokens WHERE game_id = ANY($1::text[])`,
        [initialGameIds],
      );
      await client.query(`DELETE FROM compost_event_seats WHERE event_id=$1`, [eventId]);
      await client.query(`DELETE FROM compost_event_tables WHERE event_id=$1`, [eventId]);
      await client.query(
        `DELETE FROM compost_games WHERE game_id = ANY($1::text[])`,
        [initialGameIds],
      );
      const deleted = await client.query(
        `DELETE FROM compost_events
          WHERE id=$1 AND facilitator_id=$2 AND status='completed'`,
        [eventId, check.user.id],
      );
      if (deleted.rowCount !== 1) {
        throw new Error("Completed event changed during deletion");
      }
      return { deleted: true as const, gameIds: initialGameIds };
    });
    if (!("failure" in outcome)) {
      for (const gameId of outcome.gameIds) invalidateGameCaches(gameId);
      notifyEventRemoved(eventId);
    }
    return outcome;
  });

  if ("failure" in outcome) {
    res.status(Number(outcome.failure)).json({ error: outcome.error });
    return;
  }
  res.status(204).end();
});

router.patch("/facilitator/events/:eventId", async (req, res): Promise<void> => {
  const body = req.body as { userToken?: string; name?: string; idleSeconds?: number; assignmentMode?: "choose" | "auto"; triviaEnabled?: boolean; turnTimerSeconds?: number };
  const parsedBody = UpdateFacilitatorEventBody.safeParse(body);
  if (!parsedBody.success) { res.status(400).json({ error: parsedBody.error.message }); return; }
  const check = await requireHost(req.params.eventId, body.userToken);
  if ("failure" in check) { res.status(Number(check.failure)).json({ error: check.error }); return; }
  if (body.name !== undefined && (!body.name.trim() || body.name.trim().length > 100)) { res.status(400).json({ error: "Event name must be 1-100 characters" }); return; }
  if (body.idleSeconds !== undefined && (!Number.isInteger(body.idleSeconds) || body.idleSeconds < 30 || body.idleSeconds > 3600)) { res.status(400).json({ error: "idleSeconds must be between 30 and 3600" }); return; }
  const initialTables = await tableRecords(req.params.eventId);
  const outcome = await withGameMutationLocks(initialTables.map(t => t.game_id), async client => {
    const locked = await requireHost(req.params.eventId, body.userToken, client);
    if ("failure" in locked) return { failure: Number(locked.failure), error: locked.error };
    const changed: GameState[] = [];
    await withClientTransaction(client, async () => {
      const updatedEvent = await client.query(
      `UPDATE compost_events
          SET name = COALESCE($2,name),
              idle_seconds = COALESCE($3,idle_seconds),
              assignment_mode = COALESCE($4,assignment_mode),
              trivia_enabled = COALESCE($5,trivia_enabled),
              turn_timer_seconds = COALESCE($6,turn_timer_seconds)
        WHERE id = $1
        RETURNING trivia_enabled`,
        [req.params.eventId, body.name?.trim() ?? null, body.idleSeconds ?? null, body.assignmentMode ?? null, body.triviaEnabled ?? null, body.turnTimerSeconds ?? null],
      );
      if (!updatedEvent.rows[0]) throw new Error("Event disappeared during settings update");
      for (const table of initialTables) {
        const state = await getGame(table.game_id, client);
        if (!state) continue;
        const next = body.turnTimerSeconds === undefined ? state : syncTurnClock({
          ...state, turnTimerSeconds: body.turnTimerSeconds, turnDeadlineAt: null,
          turnDeadlineKey: null, turnTimerRemainingMs: null,
        });
        if (body.turnTimerSeconds !== undefined) {
          await client.query(`UPDATE compost_games SET state=$2, updated_at=NOW() WHERE game_id=$1`,
            [next.gameId, JSON.stringify(next)]);
        }
        changed.push(next);
      }
    });
    if (body.triviaEnabled !== undefined) setEventTriviaEnabled(req.params.eventId, body.triviaEnabled);
    for (const state of changed) {
      updateGameStateCache(state);
      broadcastToGame(state.gameId, state, serializeState, client);
    }
    return { success: true };
  });
  if ("failure" in outcome) { res.status(outcome.failure!).json({ error: outcome.error }); return; }
  enqueueEventDetail(req.params.eventId);
  const detail = await buildDetail(req.params.eventId, true);
  res.json(UpdateFacilitatorEventResponse.parse(detail));
});

type TableControlResult = { gameId: string; success: boolean; error: string | null; nextState?: GameState };

async function changeTable(client: PgClient, gameId: string, action: string, text?: string): Promise<TableControlResult> {
  try {
    const event = await getEventForGame(gameId, client);
    if (event && action !== "end" && ["ending", "completed"].includes(event.status)) {
      return { gameId, success: false, error: "Event is ending or has ended" };
    }
    const state = await getGame(gameId, client);
    if (!state) return { gameId, success: false, error: "Game not found" };
    let next = state;
    if (action === "start") {
      if (state.phase === "game_over") return { gameId, success: true, error: null };
      if (event && !await isEventGameReadyToStart(gameId, client)) {
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
      next = syncTurnClock(next);
      await client.query(`UPDATE compost_games SET state = $2, updated_at = NOW() WHERE game_id = $1`, [gameId, JSON.stringify(next)]);
      updateGameStateCache(next);
      return { gameId, success: true, error: null, nextState: next };
    }
    return { gameId, success: true, error: null };
  } catch (error) {
    if (classifyDatabaseSafeguardError(error)) throw error;
    return { gameId, success: false, error: error instanceof Error ? error.message : "Control failed" };
  }
}

router.post("/facilitator/events/:eventId/control", async (req, res): Promise<void> => {
  const body = req.body as { userToken?: string; action?: string; text?: string };
  const parsedBody = ControlFacilitatorEventBody.safeParse(body);
  if (!parsedBody.success) { res.status(400).json({ error: parsedBody.error.message }); return; }
  const action = body.action ?? "";
  if (!["start", "pause_all", "resume_all", "end", "message"].includes(action)) { res.status(400).json({ error: "Invalid event action" }); return; }
  if (action === "message" && !body.text?.trim()) { res.status(400).json({ error: "Message text is required" }); return; }
  const eventId = req.params.eventId;
  const initialTables = await tableRecords(eventId);
  const outcome = await withGameMutationLocks(initialTables.map((table) => table.game_id), async (client) => {
    const check = await requireHost(eventId, body.userToken, client);
    if ("failure" in check) return { failure: Number(check.failure), error: check.error };
    const tables = await tableRecords(eventId, client);
    if (tables.length !== initialTables.length ||
        tables.some((table, index) => table.game_id !== initialTables[index]?.game_id)) {
      return { failure: 409, error: "Event tables changed; refresh and retry" };
    }
    if (["ending", "completed"].includes(check.event.status) && action !== "end") {
      return { failure: 409, error: "Event is ending or has ended" };
    }
    if (action === "end" && check.event.status !== "completed") {
      await client.query(`UPDATE compost_events SET status='ending' WHERE id=$1 AND status <> 'completed'`, [eventId]);
    }
    const results: TableControlResult[] = [];
    for (const table of tables) results.push(await changeTable(client, table.game_id, action, body.text));
    let startedAny = false;
    if (action === "start") {
      for (const table of tables) {
        const state = await getGame(table.game_id, client);
        if (state && state.phase !== "waiting" && state.phase !== "game_over") startedAny = true;
      }
    }
    if (startedAny) {
      await client.query(`UPDATE compost_events SET status='active' WHERE id=$1 AND status IN ('upcoming','active')`, [eventId]);
      await client.query(`UPDATE compost_events SET last_meaningful_activity_at=NOW() WHERE id=$1`, [eventId]);
    }
    if (action === "end" && results.every((result) => result.success)) {
      await client.query(`UPDATE compost_events SET status='completed' WHERE id=$1`, [eventId]);
    }
    return {
      results: results.map(({ gameId, success, error }) => ({ gameId, success, error })),
      changed: results.flatMap((result) => result.nextState ? [result.nextState] : []),
    };
  });
  if (typeof outcome.failure === "number") { res.status(outcome.failure).json({ error: outcome.error }); return; }
  for (const state of outcome.changed) broadcastToGame(state.gameId, state, serializeState);
  res.json(ControlFacilitatorEventResponse.parse({ eventId, action, results: outcome.results }));
  enqueueEventDetail(eventId);
});

router.post("/facilitator/events/:eventId/tables/:gameId/control", async (req, res): Promise<void> => {
  const body = req.body as { userToken?: string; action?: string; text?: string };
  const parsedBody = ControlFacilitatorEventTableBody.safeParse(body);
  if (!parsedBody.success) { res.status(400).json({ error: parsedBody.error.message }); return; }
  if (!["pause", "resume", "message"].includes(body.action ?? "")) { res.status(400).json({ error: "Invalid table action" }); return; }
  if (body.action === "message" && !body.text?.trim()) { res.status(400).json({ error: "Message text is required" }); return; }
  const eventId = req.params.eventId;
  const gameId = req.params.gameId;
  const outcome = await withGameMutationLocks([gameId], async (client) => {
    const check = await requireHost(eventId, body.userToken, client);
    if ("failure" in check) return { failure: Number(check.failure), error: check.error };
    if (["ending", "completed"].includes(check.event.status)) return { failure: 409, error: "Event is ending or has ended" };
    const table = (await tableRecords(eventId, client)).find((candidate) => candidate.game_id === gameId);
    if (!table) return { failure: 404, error: "Table not found" };
    return { result: await changeTable(client, gameId, body.action!, body.text) };
  });
  if (typeof outcome.failure === "number") { res.status(outcome.failure).json({ error: outcome.error }); return; }
  if (outcome.result.nextState) broadcastToGame(gameId, outcome.result.nextState, serializeState);
  const { success, error } = outcome.result;
  res.json(ControlFacilitatorEventTableResponse.parse({ gameId, success, error }));
  enqueueEventDetail(eventId);
});

router.post("/facilitator/events/:eventId/stream-ticket", async (req, res): Promise<void> => {
  const parsedBody = CreateFacilitatorEventStreamTicketBody.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: parsedBody.error.message });
    return;
  }
  const check = await requireHost(req.params.eventId, parsedBody.data.userToken);
  if ("failure" in check) { res.status(Number(check.failure)).json({ error: check.error }); return; }
  const ticket = issueEventStreamTicket(req.params.eventId, parsedBody.data.userToken);
  res.setHeader("Cache-Control", "no-store");
  res.json(CreateFacilitatorEventStreamTicketResponse.parse({ ticket }));
});

router.get("/facilitator/events/:eventId/stream", async (req, res): Promise<void> => {
  const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
  const grant = consumeEventStreamTicket(ticket, req.params.eventId);
  if (!grant) {
    res.status(401).json({ error: "Invalid or expired event stream ticket" });
    return;
  }
  const check = await requireHost(req.params.eventId, grant.userToken);
  if ("failure" in check) { res.status(Number(check.failure)).json({ error: check.error }); return; }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const eventId = req.params.eventId;
  let initialSnapshotSent = false;
  let updateDuringInitialSnapshot = false;
  const write = (data: unknown) => {
    if (res.destroyed || res.writableEnded) return;
    if (data && typeof data === "object" && (data as { eventRemoved?: unknown }).eventRemoved === true) {
      res.write(`event: event-removed\ndata: ${JSON.stringify({ error: "This event has been removed" })}\n\n`);
      cleanup();
      res.end();
      return;
    }
    if (!initialSnapshotSent) {
      updateDuringInitialSnapshot = true;
      return;
    }
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const subscribers = streams.get(eventId) ?? new Set<(data: unknown) => void>();
  subscribers.add(write);
  streams.set(eventId, subscribers);
  let cleanedUp = false;
  let ping: ReturnType<typeof setInterval>;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(ping);
    const current = streams.get(eventId);
    current?.delete(write);
    if (current?.size === 0) streams.delete(eventId);
  };
  ping = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(": ping\n\n");
    else cleanup();
  }, 15_000);
  res.on("close", cleanup);
  if (res.destroyed || res.writableEnded) {
    cleanup();
    return;
  }
  let initialDetail: Awaited<ReturnType<typeof buildDetail>>;
  try {
    initialDetail = await buildDetail(eventId, true);
  } catch {
    cleanup();
    res.end();
    return;
  }
  if (res.destroyed || res.writableEnded) {
    cleanup();
    return;
  }
  if (!initialDetail) {
    cleanup();
    res.end();
    return;
  }
  res.write(`data: ${JSON.stringify(initialDetail)}\n\n`);
  initialSnapshotSent = true;
  if (updateDuringInitialSnapshot) enqueueEventDetail(eventId);
});

router.get("/events/:code", async (req, res): Promise<void> => {
  const row = (await pool.query(`SELECT id,code,name,status,assignment_mode,trivia_enabled FROM compost_events WHERE code=$1`, [normalizeCode(req.params.code)])).rows[0];
  if (!row) { res.status(404).json({ error: "This event has been removed" }); return; }
  const tables = await tableRecords(row.id);
  const result = [];
  for (const table of tables) {
    const state = await getGame(table.game_id);
    result.push({
      tableNumber: table.table_number,
      capacity: table.capacity,
      occupied: Math.min(table.capacity, Math.max(0, state?.players.length ?? 0)),
      phase: state?.phase ?? "waiting",
    });
  }
  res.json(GetPublicEventResponse.parse({ code: row.code, name: row.name, status: row.status, assignmentMode: row.assignment_mode, triviaEnabled: row.trivia_enabled !== false, tables: result }));
});

router.post("/events/:code/join", async (req, res): Promise<void> => {
  const { name, tableNumber, existingToken } = req.body as { name?: string; tableNumber?: number; existingToken?: string };
  const parsedBody = JoinEventBody.safeParse(req.body);
  if (!parsedBody.success) { res.status(400).json({ error: parsedBody.error.message }); return; }
  const event = (await pool.query(`SELECT * FROM compost_events WHERE code=$1`, [normalizeCode(req.params.code)])).rows[0];
  if (!event) { res.status(404).json({ error: "This event has been removed" }); return; }
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
  const client = await acquireDatabaseClient(() => pool.connect(), "not-started");
  let clientDestroyed = false;
  let commitAttempted = false;
  let committed = false;
  let committedJoin: {
    gameId: string;
    eventId: string;
    token: string;
    playerId: string;
    playerName: string;
    tableNumber: number;
    state: GameState;
  } | null = null;
  try {
    await client.query("BEGIN");
    const lockGameIds = tables.map((table) => table.game_id).sort();
    await client.query(
      `SELECT pg_advisory_xact_lock(7419, hashtext(game_id))
         FROM unnest($1::text[]) AS lock_targets(game_id)
        ORDER BY game_id`,
      [lockGameIds],
    );
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
    commitAttempted = true;
    await client.query("COMMIT");
    committed = true;
    updateGameStateCache(joined.state);
    committedJoin = {
      gameId: table.game_id,
      eventId: event.id,
      token,
      playerId: player.id,
      playerName: player.name,
      tableNumber: table.table_number,
      state: joined.state,
    };
  } catch (error) {
    let rollbackSucceeded = false;
    if (!committed) {
      try {
        await client.query("ROLLBACK");
        rollbackSucceeded = true;
      } catch (rollbackError) {
        clientDestroyed = true;
        client.release(rollbackError instanceof Error ? rollbackError : new Error("Transaction rollback failed"));
      }
    }
    throw asDatabaseSafeguardError(
      error,
      rollbackSucceeded && !commitAttempted ? "rolled-back" : "unknown",
    );
  } finally {
    if (!clientDestroyed) client.release();
  }
  if (!committedJoin) return;
  broadcastToGame(committedJoin.gameId, committedJoin.state, serializeState);
  res.status(201).json(JoinEventResponse.parse({
    gameId: committedJoin.gameId,
    token: committedJoin.token,
    playerId: committedJoin.playerId,
    playerName: committedJoin.playerName,
    tableNumber: committedJoin.tableNumber,
  }));
  enqueueEventDetail(committedJoin.eventId);
});

async function resolveEventSeat(code: string, token: unknown, client: PgQueryable = pool) {
  if (typeof token !== "string" || !token) return null;
  const slot = await readTokenSlotConsistently(async () => {
    const row = (await client.query(
      `SELECT e.id AS event_id,e.status AS event_status,t.game_id,t.table_number,tok.player_index
         FROM compost_events e JOIN compost_event_tables t ON t.event_id=e.id
         JOIN compost_game_tokens tok ON tok.game_id=t.game_id
         WHERE e.code=$1 AND tok.token=$2`, [normalizeCode(code), token],
    )).rows[0];
    if (!row || Number(row.player_index) < 0) return null;
    const state = await getGame(row.game_id, client);
    const player = state?.players[Number(row.player_index)];
    if (!player) return null;
    const seat = await client.query(
      `SELECT ready FROM compost_event_seats WHERE game_id=$1 AND player_id=$2`, [row.game_id, player.id],
    );
    if (!seat.rows.length) return null;
    return {
      ...row,
      player_id: player.id,
      token,
      playerIndex: Number(row.player_index),
      ready: (seat.rows[0] as { ready?: boolean }).ready === true,
    };
  });
  return slot ?? null;
}

type EventReadyResult =
  | { status: 200; eventId: string }
  | { status: 403 | 409; error: string };

router.get("/events/:code/ready", async (req, res): Promise<void> => {
  const seat = await resolveEventSeat(req.params.code, req.query.token);
  if (!seat) {
    if (!await eventCodeIsPresent(req.params.code)) {
      res.status(404).json({ error: "This event has been removed" });
      return;
    }
    res.status(403).json({ error: "Invalid event seat token" });
    return;
  }
  res.json(GetEventReadyResponse.parse({ ready: seat.ready }));
});

router.post("/events/:code/ready", async (req, res): Promise<void> => {
  const body = req.body as { token?: string; ready?: boolean };
  const parsedBody = SetEventReadyBody.safeParse(body);
  if (!parsedBody.success) { res.status(400).json({ error: parsedBody.error.message }); return; }
  const seat = await resolveEventSeat(req.params.code, body.token);
  if (!seat) {
    if (!await eventCodeIsPresent(req.params.code)) {
      res.status(404).json({ error: "This event has been removed" });
      return;
    }
    res.status(403).json({ error: "Invalid event seat token" });
    return;
  }
  const result = await withGameMutationLocks<EventReadyResult>([seat.game_id], async (client) => {
    const refreshed = await resolveEventSeat(req.params.code, body.token, client);
    if (!refreshed) return { status: 403, error: "Invalid event seat token" };
    if (refreshed.game_id !== seat.game_id) {
      throw new DatabaseSafeguardError("advisory_lock", "not-started");
    }
    if (["ending", "completed"].includes(refreshed.event_status)) return { status: 409, error: "Event is ending or has ended" };
    return withClientTransaction(client, async () => {
      await client.query(`UPDATE compost_event_seats SET ready=$3 WHERE game_id=$1 AND player_id=$2`,
        [refreshed.game_id, refreshed.player_id, body.ready === true]);
      return { status: 200, eventId: refreshed.event_id };
    });
  });
  if (result.status !== 200) { res.status(result.status).json({ error: result.error }); return; }
  res.json(SetEventReadyResponse.parse({ ok: true }));
  enqueueEventDetail(result.eventId);
});

router.post("/events/:code/presence", async (req, res): Promise<void> => {
  const parsedBody = HeartbeatEventPresenceBody.safeParse(req.body);
  if (!parsedBody.success) { res.status(400).json({ error: parsedBody.error.message }); return; }
  let matchedEventId: string | undefined;
  await updateEventPresenceAndPublishTransition(async () => {
    const result = await pool.query(
      `WITH candidate AS MATERIALIZED (
         SELECT seat.id,seat.event_id,seat.last_seen_at
           FROM compost_event_seats seat
           JOIN compost_events e ON e.id=seat.event_id
           JOIN compost_event_tables t ON t.event_id=e.id AND t.game_id=seat.game_id
           JOIN compost_game_tokens tok ON tok.game_id=t.game_id
           JOIN compost_games g ON g.game_id=t.game_id
          WHERE e.code=$1 AND tok.token=$2 AND tok.player_index>=0
            AND seat.player_index=tok.player_index
            AND seat.player_id=g.state::jsonb #>> ARRAY['players',tok.player_index::text,'id']
          FOR UPDATE OF seat
       ), touched AS (
         UPDATE compost_event_seats seat
            SET last_seen_at=NOW()
           FROM candidate
          WHERE seat.id=candidate.id
         RETURNING seat.id
       )
       SELECT candidate.event_id,candidate.last_seen_at
         FROM candidate JOIN touched USING (id)`,
      [normalizeCode(req.params.code), parsedBody.data.token],
    );
    if (!result.rows.length) return undefined;
    matchedEventId = result.rows[0].event_id as string;
    return result.rows[0].last_seen_at ?? null;
  }, async () => {
    if (matchedEventId) enqueueEventDetail(matchedEventId);
  });
  if (!matchedEventId) {
    if (!await eventCodeIsPresent(req.params.code)) {
      res.status(404).json({ error: "This event has been removed" });
      return;
    }
    res.status(403).json({ error: "Invalid event seat token" });
    return;
  }
  res.json(HeartbeatEventPresenceResponse.parse({ ok: true }));
});

export default router;