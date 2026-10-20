import { pool } from "@workspace/db";
import { GameState, runBotTurnsIfNeeded, takeOverPlayerAsBot } from "./gameEngine.js";
import type { Response } from "express";
import { randomBytes } from "node:crypto";
import {
  asDatabaseSafeguardError,
  rollbackDatabaseTransaction,
  unlockThenReleaseDatabaseClient,
} from "./databaseSafeguards.js";
import { GameStoreCache } from "./gameStoreCache.js";
import { syncTurnClock } from "./turnClock.js";
import { STORE_GAME_WITH_ANALYTICS_SQL } from "./gameAnalytics.js";
import { updateRoundRoster } from "./gameReplay.js";

export type PgQueryResult = { rows: any[]; rowCount?: number | null };
export type PgQueryable = { query: (...args: any[]) => Promise<PgQueryResult> };
export type PgClient = PgQueryable & { release: (error?: Error | boolean) => void };

// ── In-memory only: live SSE connections (can't persist HTTP streams) ──────────
type SseConnection = {
  res: Response;
  playerIndex: number | undefined;
  playerId?: string;
  revoked: boolean;
};
const sseClientsByToken = new Map<string, Map<string, SseConnection>>();

// ── In-memory game state cache ────────────────────────────────────────────────
// Eliminates a DB read on every action — the DB remains the durable backup.
const gameStoreCache = new GameStoreCache<GameState>();
const gameBroadcastListeners = new Set<(gameId: string) => void>();
const deferredBroadcastsByClient = new WeakMap<PgClient, Set<string>>();
const destroyedClients = new WeakSet<PgClient>();
let tokenPublicationEpoch = 0;
let gameClock: { arm: (state: GameState) => void; read: (state: GameState, client?: PgQueryable) => Promise<GameState>; remove: (id: string) => void } | undefined;
export function registerGameClock(clock: NonNullable<typeof gameClock>): void { gameClock = clock; }

const cacheEvictionTimer = setInterval(() => {
  gameStoreCache.evict();
}, 15 * 60 * 1_000);
cacheEvictionTimer.unref();

/** Run one bounded eviction pass; exported so cache policy can be tested deterministically. */
export function evictGameStoreCache(now = Date.now(), maxEntries?: number): string[] {
  return gameStoreCache.evict(now, maxEntries);
}

/** Invalidate every process-local cache for a game after a durable deletion. */
export function invalidateGameCaches(gameId: string): void {
  gameClock?.remove(gameId);
  tokenPublicationEpoch++;
  gameStoreCache.deleteGame(gameId);
  const clients = sseClientsByToken.get(gameId);
  sseClientsByToken.delete(gameId);
  for (const { res: response } of clients?.values() ?? []) {
    try {
      response.write(`event: event-removed\ndata: {"error":"This event has been removed"}\n\n`);
      response.end();
    } catch {}
  }
}

function recordAuthoritativeGameChange(gameId: string): void {
  tokenPublicationEpoch++;
  gameStoreCache.advanceGeneration(gameId);
}

function recordUncachedGameChange(gameId: string, invalidateState: boolean): void {
  tokenPublicationEpoch++;
  if (invalidateState) gameStoreCache.invalidateState(gameId);
  else gameStoreCache.invalidateTokenIndex(gameId);
}

/** Publish committed credentials without making streams depend on cache lifetime. */
function publishTokenIndex(gameId: string, index: Map<string, number>, complete = false): void {
  gameStoreCache.setTokenIndex(gameId, index);
  const state = complete ? gameStoreCache.getState(gameId) : undefined;
  for (const [token, connection] of sseClientsByToken.get(gameId) ?? []) {
    const seat = index.get(token);
    if (seat !== undefined && !connection.revoked) {
      connection.playerIndex = seat;
      if (state) connection.playerId = state.players[seat]?.id;
    } else if (complete && seat === undefined) {
      connection.revoked = true;
      connection.playerIndex = undefined;
    }
  }
}

function revokeSseToken(gameId: string, token: string): void {
  const connection = sseClientsByToken.get(gameId)?.get(token);
  if (connection) {
    connection.revoked = true;
    connection.playerIndex = undefined;
  }
}

function repairUnknownSseSeat(gameId: string, token: string, playerIndex: number): void {
  const connection = sseClientsByToken.get(gameId)?.get(token);
  if (connection && !connection.revoked && connection.playerIndex === undefined) {
    connection.playerIndex = playerIndex;
  }
}

/** Also shift live seats when the token cache has been evicted or invalidated. */
function removeSseSeat(gameId: string, removedIndex: number, shift: boolean): void {
  for (const connection of sseClientsByToken.get(gameId)?.values() ?? []) {
    if (connection.playerIndex === removedIndex) {
      connection.revoked = true;
      connection.playerIndex = undefined;
    } else if (shift && connection.playerIndex !== undefined && connection.playerIndex > removedIndex) {
      connection.playerIndex--;
    }
  }
}

/**
 * Token lookups may not know the game ID until after their first query. Retry
 * once if any committed game/token mutation overlaps the complete lookup.
 * The callback retains its supplied client, so held-client reads never acquire
 * a nested pool connection.
 */
export async function readTokenSlotConsistently<T>(
  load: () => Promise<T>,
): Promise<T | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const epoch = tokenPublicationEpoch;
    const value = await load();
    if (epoch === tokenPublicationEpoch) return value;
  }
  return undefined;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function destroyClient(client: PgClient, error: unknown): void {
  if (destroyedClients.has(client)) return;
  destroyedClients.add(client);
  client.release(asError(error));
}

async function rollbackClientTransaction(client: PgClient): Promise<boolean> {
  const rolledBack = await rollbackDatabaseTransaction(client, () => client.query("ROLLBACK"));
  if (!rolledBack) destroyedClients.add(client);
  return rolledBack;
}

function safelyClassifyFailedTransaction(error: unknown, rollbackSucceeded: boolean): unknown {
  return asDatabaseSafeguardError(error, rollbackSucceeded ? "rolled-back" : "unknown");
}

async function connectDatabaseClient(): Promise<PgClient> {
  try {
    return await pool.connect();
  } catch (error) {
    throw asDatabaseSafeguardError(error, "not-started");
  }
}

export function createGameId(): string {
  return generateId();
}

// ── Game state ────────────────────────────────────────────────────────────────

export async function storeGame(state: GameState, client: PgQueryable = pool): Promise<void> {
  Object.assign(state, syncTurnClock(state));
  // Stamp the finish time once, regardless of how the game ended (win or
  // manual end), so post-session summaries can show duration.
  const snapshot = JSON.parse(JSON.stringify(state)) as GameState;
  if (snapshot.phase === "game_over" && !snapshot.endedAt) {
    snapshot.endedAt = Date.now();
  }
  await client.query(
    STORE_GAME_WITH_ANALYTICS_SQL,
    [snapshot.gameId, JSON.stringify(snapshot), process.env.NODE_ENV === "test"]
  );
  // A supplied client may be inside a transaction that this function does not
  // own. Drop the old snapshot rather than exposing an uncommitted write.
  if (client === pool) {
    recordAuthoritativeGameChange(snapshot.gameId);
    gameStoreCache.setState(snapshot);
  }
  else {
    recordUncachedGameChange(snapshot.gameId, true);
    if (snapshot.eventId) gameStoreCache.markEventMembership(snapshot.gameId, true);
  }
  gameClock?.arm(snapshot);
}

/** Keep the durable transaction's committed state visible to normal game readers. */
export function updateGameStateCache(state: GameState): void {
  recordAuthoritativeGameChange(state.gameId);
  gameStoreCache.setState(state);
  gameClock?.arm(state);
}

/** Read an already cached snapshot without falling through to a database query. */
export function getCachedGameState(gameId: string): GameState | undefined {
  return gameStoreCache.getState(gameId);
}

export function onGameBroadcast(listener: (gameId: string) => void): () => void {
  gameBroadcastListeners.add(listener);
  return () => gameBroadcastListeners.delete(listener);
}

export async function getGame(gameId: string, client?: PgQueryable): Promise<GameState | undefined> {
  const queryable = client ?? pool;
  const canCache = queryable === pool;
  if (canCache) {
    const cached = gameStoreCache.getState(gameId);
    if (cached) {
      if (!cached.eventId && !gameStoreCache.knowsEventMembership(gameId)) {
        const read = gameStoreCache.beginRead(gameId);
        try {
          const isEventMember = await isGameEventMember(gameId, queryable);
          gameStoreCache.publishIfCurrent(read, () =>
            gameStoreCache.markEventMembership(gameId, isEventMember));
        } finally {
          gameStoreCache.finishRead(read);
        }
      }
      return gameClock ? gameClock.read(cached, canCache ? undefined : client) : cached;
    }
  }
  const read = canCache ? gameStoreCache.beginRead(gameId) : undefined;
  try {
    const result = await queryable.query(
      `SELECT state FROM compost_games WHERE game_id = $1`,
      [gameId]
    );
    if (result.rows.length === 0) {
      if (read) gameStoreCache.clearGameIfCurrent(read);
      return undefined;
    }
    const row = result.rows[0];
    const state = JSON.parse(JSON.stringify(
      (typeof row.state === "string" ? JSON.parse(row.state) : row.state) as GameState,
    )) as GameState;
    if (read) {
      const isEventMember = state.eventId ? true : await isGameEventMember(gameId, queryable);
      gameStoreCache.publishIfCurrent(read, () =>
        gameStoreCache.setState(state, Date.now(), isEventMember));
    }
    const copy = JSON.parse(JSON.stringify(state)) as GameState;
    return gameClock ? gameClock.read(copy, canCache ? undefined : client) : copy;
  } finally {
    if (read) gameStoreCache.finishRead(read);
  }
}

async function isGameEventMember(gameId: string, client: PgQueryable): Promise<boolean> {
  try {
    const result = await client.query(
      `SELECT 1 FROM compost_event_tables WHERE game_id=$1 LIMIT 1`,
      [gameId],
    );
    return result.rows.length > 0;
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return false;
    throw error;
  }
}

async function ensureCachedEventMembership(gameId: string, client: PgQueryable): Promise<void> {
  if (!gameStoreCache.knowsEventMembership(gameId)) {
    const read = gameStoreCache.beginRead(gameId);
    try {
      const isEventMember = await isGameEventMember(gameId, client);
      gameStoreCache.publishIfCurrent(read, () =>
        gameStoreCache.markEventMembership(gameId, isEventMember));
    } finally {
      gameStoreCache.finishRead(read);
    }
  }
}

async function eventLookupInTransaction<T>(client: PgClient, query: () => Promise<T>): Promise<T | null> {
  await client.query("SAVEPOINT event_table_lookup");
  try {
    const result = await query();
    await client.query("RELEASE SAVEPOINT event_table_lookup");
    return result;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT event_table_lookup");
    await client.query("RELEASE SAVEPOINT event_table_lookup");
    if ((error as { code?: string }).code === "42P01") return null;
    throw error;
  }
}

export async function reloadGameState(
  gameId: string,
  client: PgQueryable = pool,
  options: { cacheGlobal?: boolean } = {},
): Promise<GameState | undefined> {
  const canCache = client === pool || options.cacheGlobal === true;
  const read = canCache ? gameStoreCache.beginRead(gameId) : undefined;
  try {
    const result = await client.query(`SELECT state FROM compost_games WHERE game_id=$1`, [gameId]);
    if (!result.rows.length) {
      if (read) gameStoreCache.clearGameIfCurrent(read);
      return undefined;
    }
    const value = result.rows[0].state;
    const state = JSON.parse(JSON.stringify(
      (typeof value === "string" ? JSON.parse(value) : value) as GameState,
    )) as GameState;
    if (read) {
      const isEventMember = state.eventId ? true : await isGameEventMember(gameId, client);
      const tokenRows = await client.query(`SELECT token,player_index FROM compost_game_tokens WHERE game_id=$1`, [gameId]);
      const tokenIndex = new Map(tokenRows.rows.map((row: { token: string; player_index: number | string }) =>
        [row.token, Number(row.player_index)]));
      gameStoreCache.publishIfCurrent(read, () => {
        gameStoreCache.setState(state, Date.now(), isEventMember);
        publishTokenIndex(gameId, tokenIndex, true);
      });
      gameClock?.arm(state);
    }
    return JSON.parse(JSON.stringify(state)) as GameState;
  } finally {
    if (read) gameStoreCache.finishRead(read);
  }
}

export async function acquireGameMutationLock(gameId: string): Promise<PgClient> {
  const client = await connectDatabaseClient();
  try {
    await client.query(`SELECT pg_advisory_lock(7419, hashtext($1))`, [gameId]);
    // This client owns a session advisory lock, not an open transaction; its
    // reads reflect committed state and may safely refresh the process cache.
    await reloadGameState(gameId, client, { cacheGlobal: true });
    return client;
  } catch (error) {
    let unlockError: unknown;
    try {
      await client.query(`SELECT pg_advisory_unlock(7419, hashtext($1))`, [gameId]);
    } catch (cleanupError) {
      unlockError = cleanupError;
    } finally {
      if (unlockError) destroyClient(client, unlockError);
      else if (!destroyedClients.has(client)) client.release();
    }
    throw asDatabaseSafeguardError(error, "not-started");
  }
}

export async function releaseGameMutationLock(client: PgClient, gameId: string): Promise<void> {
  if (destroyedClients.has(client)) return;
  await unlockThenReleaseDatabaseClient(
    client,
    () => client.query(`SELECT pg_advisory_unlock(7419, hashtext($1))`, [gameId]),
  );
  flushDeferredBroadcasts(client);
}

export async function releaseGameMutationLockSafely(
  client: PgClient,
  gameId: string,
  logError: (entry: string) => void = (entry) => console.error(entry),
): Promise<void> {
  try {
    await releaseGameMutationLock(client, gameId);
  } catch (error) {
    const errorCode = error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
    const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*Error$/.test(error.name)
      ? error.name
      : "Error";
    const entry = JSON.stringify({
      level: "error",
      event: "game_mutation_lock_release_failed",
      errorName,
      errorCode: typeof errorCode === "string" && /^[A-Z0-9]{5}$/.test(errorCode) ? errorCode : undefined,
    });
    try { logError(entry); } catch { /* logging must not restore an unhandled cleanup rejection */ }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function flushDeferredBroadcasts(client: PgClient): void {
  const gameIds = deferredBroadcastsByClient.get(client);
  if (!gameIds) return;
  deferredBroadcastsByClient.delete(client);
  for (const gameId of gameIds) {
    for (const listener of gameBroadcastListeners) {
      try { listener(gameId); } catch { /* a stream subscriber must not break gameplay broadcasts */ }
    }
  }
}

export async function lockGameMutationInTransaction(client: PgClient, gameId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(7419, hashtext($1))`, [gameId]);
}

export async function withClientTransaction<T>(
  client: PgClient,
  action: () => Promise<T>,
): Promise<T> {
  let began = false;
  let commitAttempted = false;
  let committed = false;
  try {
    await client.query("BEGIN");
    began = true;
    const result = await action();
    commitAttempted = true;
    await client.query("COMMIT");
    committed = true;
    return result;
  } catch (error) {
    if (committed) throw safelyClassifyFailedTransaction(error, false);
    if (!began) throw asDatabaseSafeguardError(error, "not-started");
    const rollbackSucceeded = await rollbackClientTransaction(client);
    throw safelyClassifyFailedTransaction(error, rollbackSucceeded && !commitAttempted);
  }
}

export async function withGameMutationLocks<T>(
  gameIds: string[],
  action: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = await connectDatabaseClient();
  const sortedGameIds = [...new Set(gameIds)].sort();
  let actionStarted = false;
  try {
    if (sortedGameIds.length) {
      await client.query(
        `SELECT pg_advisory_lock(7419, hashtext(lock_targets.game_id))
           FROM (SELECT unnest($1::text[]) AS game_id ORDER BY game_id) AS lock_targets`,
        [sortedGameIds],
      );
    }
    for (const gameId of sortedGameIds) {
      // Session locks are held outside a transaction, so this snapshot is
      // durable. Xact-lock callers must use reloadGameState's safe default.
      await reloadGameState(gameId, client, { cacheGlobal: true });
    }
    actionStarted = true;
    return await action(client);
  } catch (error) {
    throw actionStarted ? error : asDatabaseSafeguardError(error, "not-started");
  } finally {
    if (!destroyedClients.has(client)) {
      let unlockError: unknown;
      for (const gameId of [...sortedGameIds].reverse()) {
        try {
          await client.query(`SELECT pg_advisory_unlock(7419, hashtext($1))`, [gameId]);
        } catch (error) {
          unlockError ??= error;
        }
      }
      if (unlockError) {
        destroyClient(client, unlockError);
        throw asDatabaseSafeguardError(unlockError, actionStarted ? "unknown" : "not-started");
      }
      client.release();
      flushDeferredBroadcasts(client);
    }
  }
}

export async function isEventGameReadyToStart(gameId: string, client?: PgQueryable): Promise<boolean> {
  const event = await getEventForGame(gameId, client);
  if (!event) return false;
  const state = await getGame(gameId, client);
  if (!state || state.phase !== "waiting" || state.players.length < 2) return false;
  const result = await (client ?? pool).query(
    `SELECT player_id,ready,last_seen_at FROM compost_event_seats WHERE event_id=$1 AND game_id=$2`,
    [event.eventId, gameId],
  );
  const seats = result.rows as Array<{ player_id: string; ready: boolean; last_seen_at: Date | null }>;
  const byPlayerId = new Map(seats.map((seat) => [seat.player_id, seat]));
  return state.players.length === seats.length && state.players.every((player) => {
    const seat = byPlayerId.get(player.id);
    return !!seat?.ready && !!seat.last_seen_at &&
      Date.now() - new Date(seat.last_seen_at).getTime() <= 45_000;
  });
}

// ── Password ──────────────────────────────────────────────────────────────────

export async function setGamePassword(gameId: string, password: string, client: PgQueryable = pool): Promise<void> {
  await client.query(
    `UPDATE compost_games SET password = $2 WHERE game_id = $1`,
    [gameId, password]
  );
}

export async function gameHasPassword(gameId: string, client: PgQueryable = pool): Promise<boolean> {
  const result = await client.query(
    `SELECT password FROM compost_games WHERE game_id = $1`,
    [gameId]
  );
  if (result.rows.length === 0) return false;
  return result.rows[0].password != null;
}

export async function checkGamePassword(gameId: string, password: string, client: PgQueryable = pool): Promise<boolean> {
  const result = await client.query(
    `SELECT password FROM compost_games WHERE game_id = $1`,
    [gameId]
  );
  if (result.rows.length === 0) return true;
  const stored: string | null = result.rows[0].password;
  if (stored == null) return true;
  return stored === password;
}

// ── Waiting rooms ─────────────────────────────────────────────────────────────

export async function getAllWaitingRooms(): Promise<Array<{
  gameId: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
  hasPassword: boolean;
}>> {
  const result = await pool.query(
    `SELECT game_id,
            state,
            password
     FROM compost_games
     WHERE state->>'phase' = 'waiting'
       AND state->>'mode'  = 'online'
     ORDER BY updated_at DESC`
  );
  return result.rows.map((row) => {
    const state: GameState =
      typeof row.state === "string" ? JSON.parse(row.state) : row.state;
    return {
      gameId: row.game_id,
      hostName: state.players[0]?.name ?? "Unknown",
      playerCount: state.players.length,
      maxPlayers: (state as any).maxPlayers ?? 4,
      hasPassword: row.password != null,
    };
  });
}

// ── Facilitator sessions ──────────────────────────────────────────────────────

export async function getGamesByFacilitator(facilitatorId: string): Promise<GameState[]> {
  let result;
  try {
    result = await pool.query(
      `SELECT state FROM compost_games
       WHERE state->>'facilitatorId' = $1
         AND NOT EXISTS (SELECT 1 FROM compost_event_tables et WHERE et.game_id = compost_games.game_id)
       ORDER BY updated_at DESC
       LIMIT 50`,
      [facilitatorId]
    );
  } catch (error) {
    if ((error as { code?: string }).code !== "42P01") throw error;
    result = await pool.query(
      `SELECT state FROM compost_games
       WHERE state->>'facilitatorId' = $1 AND state->>'eventId' IS NULL
       ORDER BY updated_at DESC LIMIT 50`,
      [facilitatorId]
    );
  }
  return result.rows.map((row) =>
    typeof row.state === "string" ? JSON.parse(row.state) : row.state
  );
}

export async function getEventForGame(gameId: string, client: PgQueryable = pool): Promise<{ eventId: string; status: string } | null> {
  try {
    const result = await client.query(
      `SELECT e.id AS event_id, e.status
         FROM compost_event_tables t JOIN compost_events e ON e.id=t.event_id
        WHERE t.game_id=$1 LIMIT 1`, [gameId],
    );
    return result.rows[0] ? { eventId: result.rows[0].event_id, status: result.rows[0].status } : null;
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return null;
    throw error;
  }
}

// ── Tokens ────────────────────────────────────────────────────────────────────

export async function claimSlot(
  gameId: string,
  existingToken?: string,
  client?: PgQueryable,
): Promise<{ token: string; playerIndex: number } | null> {
  const queryable = client ?? pool;
  const game = await getGame(gameId, client);
  if (!game) return null;

  // Check if existing token is valid
  if (existingToken) {
    const check = await queryable.query(
      `SELECT player_index FROM compost_game_tokens
       WHERE game_id = $1 AND token = $2`,
      [gameId, existingToken]
    );
    if (check.rows.length > 0) {
      return { token: existingToken, playerIndex: check.rows[0].player_index };
    }
    // A supplied credential is a rejoin request, never permission to claim a
    // different available seat when that credential is invalid here.
    return null;
  }

  // A newly issued credential must never reclaim a seat that is occupied by a
  // bot takeover during an in-progress game.
  if (game.phase !== "waiting") return null;

  // Find next unclaimed player index
  const takenResult = await queryable.query(
    `SELECT player_index FROM compost_game_tokens WHERE game_id = $1`,
    [gameId]
  );
  const claimedIndices = new Set<number>(takenResult.rows.map((r) => r.player_index));

  let nextIndex = -1;
  for (let i = 0; i < game.players.length; i++) {
    if (!claimedIndices.has(i)) {
      nextIndex = i;
      break;
    }
  }
  if (nextIndex === -1) return null;

  const token = generateToken();
  await queryable.query(
    `INSERT INTO compost_game_tokens (game_id, token, player_index)
     VALUES ($1, $2, $3)`,
    [gameId, token, nextIndex]
  );
  if (queryable === pool) recordAuthoritativeGameChange(gameId);
  if (queryable === pool) {
    const nextIndexMap = new Map(gameStoreCache.getTokenIndex(gameId) ?? []);
    nextIndexMap.set(token, nextIndex);
    publishTokenIndex(gameId, nextIndexMap);
  } else {
    recordUncachedGameChange(gameId, false);
  }
  return { token, playerIndex: nextIndex };
}

/** Find the room currently owning a credential, for durable transfer recovery. */
export async function getGameIdForToken(token: string, client: PgQueryable = pool): Promise<string | null> {
  const gameId = await readTokenSlotConsistently(async () => {
    const result = await client.query(
      `SELECT game_id FROM compost_game_tokens WHERE token = $1 LIMIT 1`,
      [token]
    );
    return (result.rows[0]?.game_id as string | undefined) ?? null;
  });
  return gameId ?? null;
}

/** Mint the reserved, non-player token used by a new spectator-host session. */
export async function createSpectatorHostToken(gameId: string, client: PgQueryable = pool): Promise<string> {
  if (client === pool) await ensureCachedEventMembership(gameId, client);
  const token = generateToken();
  await client.query(
    `INSERT INTO compost_game_tokens (game_id, token, player_index) VALUES ($1, $2, -1)`,
    [gameId, token]
  );
  if (client === pool) recordAuthoritativeGameChange(gameId);
  if (client === pool) {
    const nextIndexMap = new Map(gameStoreCache.getTokenIndex(gameId) ?? []);
    nextIndexMap.set(token, -1);
    publishTokenIndex(gameId, nextIndexMap);
  } else {
    recordUncachedGameChange(gameId, false);
  }
  return token;
}

/**
 * Reorder waiting-room participants and their seat credentials in one DB
 * transaction. Players are matched by stable player ID, not by old seat.
 */
export async function reorderWaitingPlayers(
  gameId: string,
  playerIds: string[],
  heldClient?: PgClient,
): Promise<GameState | null> {
  const ownsClient = !heldClient;
  const client = heldClient ?? await connectDatabaseClient();
  let commitAttempted = false;
  let committed = false;
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT state FROM compost_games WHERE game_id = $1 FOR UPDATE`,
      [gameId]
    );
    if (!locked.rows.length) { await client.query("ROLLBACK"); return null; }
    const state = (typeof locked.rows[0].state === "string"
      ? JSON.parse(locked.rows[0].state) : locked.rows[0].state) as GameState;
    if (state.mode !== "facilitated" || state.phase !== "waiting") {
      await client.query("ROLLBACK");
      return null;
    }
    const legacyHost = state.hostIsSpectator !== true;
    const host = legacyHost ? state.players[0] : undefined;
    const guests = legacyHost ? state.players.slice(1) : state.players;
    if (playerIds.length !== guests.length || new Set(playerIds).size !== playerIds.length ||
        playerIds.some((id) => !guests.some((p) => p.id === id))) {
      await client.query("ROLLBACK");
      return null;
    }
    const ordered = playerIds.map((id) => guests.find((p) => p.id === id)!);
    const newPlayers = host ? [host, ...ordered] : ordered;
    const nextState = { ...state, players: newPlayers };
    const tokenRows = await client.query(
      `SELECT token, player_index FROM compost_game_tokens WHERE game_id = $1 FOR UPDATE`,
      [gameId]
    );
    // Move all participant tokens out of the live index range before assigning
    // new indices, so uniqueness constraints cannot observe a transient clash.
    const guestOffset = host ? 1 : 0;
    for (const row of tokenRows.rows) {
      const index = Number(row.player_index);
      if (index >= guestOffset && index < state.players.length) {
        await client.query(
          `UPDATE compost_game_tokens SET player_index = $3 WHERE game_id = $1 AND token = $2`,
          [gameId, row.token, -100000 - index]
        );
      }
    }
    for (let index = guestOffset; index < newPlayers.length; index++) {
      const oldIndex = state.players.findIndex((p) => p.id === newPlayers[index].id);
      const row = tokenRows.rows.find((r) => Number(r.player_index) === oldIndex);
      if (row) {
        await client.query(
          `UPDATE compost_game_tokens SET player_index = $3 WHERE game_id = $1 AND token = $2`,
          [gameId, row.token, index]
        );
      }
    }
    let eventId = state.eventId;
    if (!eventId) {
      const linked = await eventLookupInTransaction(client,
        () => client.query(`SELECT event_id FROM compost_event_tables WHERE game_id=$1`, [gameId]));
      eventId = linked?.rows[0]?.event_id;
    }
    if (eventId) {
      for (let index = guestOffset; index < newPlayers.length; index++) {
        await client.query(
          `UPDATE compost_event_seats SET player_index=$4
            WHERE event_id=$1 AND game_id=$2 AND player_id=$3`,
          [eventId, gameId, newPlayers[index].id, index],
        );
      }
    }
    await storeGame(nextState, client);
    commitAttempted = true;
    await client.query("COMMIT");
    committed = true;
    recordAuthoritativeGameChange(gameId);
    gameStoreCache.setState(nextState);
    if (eventId) gameStoreCache.markEventMembership(gameId, true);
    const nextMap = new Map<string, number>();
    for (const row of tokenRows.rows) {
      const index = Number(row.player_index);
      if (index === -1 && state.hostIsSpectator === true) nextMap.set(row.token, -1);
      else if (legacyHost && index === 0) nextMap.set(row.token, 0);
      else {
        const oldIndex = index >= guestOffset && index < state.players.length ? index : -1;
        const player = oldIndex >= 0 ? state.players[oldIndex] : undefined;
        const newIndex = player ? newPlayers.findIndex((p) => p.id === player.id) : -1;
        if (newIndex >= guestOffset) nextMap.set(row.token, newIndex);
      }
    }
    publishTokenIndex(gameId, nextMap, true);
    return nextState;
  } catch (error) {
    if (committed) throw safelyClassifyFailedTransaction(error, false);
    const rollbackSucceeded = await rollbackClientTransaction(client);
    throw safelyClassifyFailedTransaction(error, rollbackSucceeded && !commitAttempted);
  } finally {
    if (ownsClient && !destroyedClients.has(client)) client.release();
  }
}

export async function transferWaitingPlayer(
  sourceGameId: string,
  targetGameId: string,
  playerId: string,
  heldClient?: PgClient,
): Promise<{ source: GameState; target: GameState; token: string } | null> {
  const ownsClient = !heldClient;
  const client = heldClient ?? await connectDatabaseClient();
  let commitAttempted = false;
  let committed = false;
  try {
    await client.query("BEGIN");
    const ids = [sourceGameId, targetGameId].sort();
    const rows = new Map<string, GameState>();
    for (const id of ids) {
      const result = await client.query(
        `SELECT state FROM compost_games WHERE game_id = $1 FOR UPDATE`,
        [id]
      );
      if (!result.rows.length) { await client.query("ROLLBACK"); return null; }
      rows.set(id, (typeof result.rows[0].state === "string"
        ? JSON.parse(result.rows[0].state) : result.rows[0].state) as GameState);
    }
    const source = rows.get(sourceGameId)!;
    const target = rows.get(targetGameId)!;
    const validRoom = (g: GameState) => g.mode === "facilitated" && ["waiting", "game_over"].includes(g.phase);
    if (!validRoom(source) || !validRoom(target) || source.facilitatorId !== target.facilitatorId ||
        sourceGameId === targetGameId || (target.maxPlayers ?? 4) <= target.players.length ||
        (source.hostIsSpectator !== true && source.players[0]?.id === playerId)) {
      await client.query("ROLLBACK");
      return null;
    }
    let eventMembership: { eventId: string; status: string } | null = null;
    let sourceEventId: string | null = null;
    let targetEventId: string | null = null;
    const eventRows = await eventLookupInTransaction(client, () => client.query(
        `SELECT t.game_id,e.id AS event_id,e.status
           FROM compost_event_tables t JOIN compost_events e ON e.id=t.event_id
          WHERE t.game_id = ANY($1::text[])`, [[sourceGameId, targetGameId]],
      ));
    if (eventRows) {
      for (const row of eventRows.rows) {
        if (row.game_id === sourceGameId) sourceEventId = row.event_id;
        if (row.game_id === targetGameId) targetEventId = row.event_id;
        if (row.game_id === sourceGameId) eventMembership = { eventId: row.event_id, status: row.status };
      }
    }
    if (sourceEventId !== targetEventId || (eventMembership && !["upcoming", "active"].includes(eventMembership.status))) {
      await client.query("ROLLBACK");
      return null;
    }
    const playerIndex = source.players.findIndex((p) => p.id === playerId);
    if (playerIndex < (source.hostIsSpectator === true ? 0 : 1)) {
      await client.query("ROLLBACK");
      return null;
    }
    const tokenRows = await client.query(
      `SELECT token, player_index FROM compost_game_tokens WHERE game_id = $1 FOR UPDATE`,
      [sourceGameId]
    );
    const movingRow = tokenRows.rows.find((r) => Number(r.player_index) === playerIndex);
    if (!movingRow) {
      await client.query("ROLLBACK");
      return null;
    }
    if (eventMembership) {
      const seat = await client.query(
        `SELECT id FROM compost_event_seats WHERE event_id=$1 AND game_id=$2 AND player_id=$3 FOR UPDATE`,
        [eventMembership.eventId, sourceGameId, playerId],
      );
      if (!seat.rows.length) {
        await client.query("ROLLBACK");
        return null;
      }
    }
    let movedPlayer = source.players[playerIndex];
    const usedIds = new Set([
      ...target.players.map(player => player.id),
      ...(target.roundHistory ?? []).flatMap(round => round.standings.map(player => player.playerId)),
    ]);
    if (usedIds.has(playerId)) {
      let uniqueId = `player_${generateId()}_${generateId()}`;
      while (usedIds.has(uniqueId)) uniqueId = `player_${generateId()}_${generateId()}`;
      movedPlayer = { ...movedPlayer, id: uniqueId };
    }
    // Old-round cards and effects must never move into another table.
    movedPlayer = {
      ...movedPlayer, hand: [], compostPile: [], skipsNextTurn: false,
      maxHandSize: 5, drawsExtraCard: false, consecutiveMissedTurns: 0,
      lastMissedTurnNumber: undefined,
    };
    const sourcePlayers = source.players.filter((p) => p.id !== playerId);
    const targetPlayers = [...target.players, movedPlayer];
    const nextSource = updateRoundRoster(source, sourcePlayers);
    const nextTarget = updateRoundRoster(target, targetPlayers);
    const movedToken = movingRow.token as string;
    // Make source seats temporary before shifting down to avoid index collisions.
    for (const row of tokenRows.rows) {
      const index = Number(row.player_index);
      if (index >= playerIndex) {
        await client.query(
          `UPDATE compost_game_tokens SET player_index = $3 WHERE game_id = $1 AND token = $2`,
          [sourceGameId, row.token, -200000 - index]
        );
      }
    }
    for (const row of tokenRows.rows) {
      const oldIndex = Number(row.player_index);
      if (oldIndex > playerIndex) {
        await client.query(
          `UPDATE compost_game_tokens SET player_index = $3 WHERE game_id = $1 AND token = $2`,
          [sourceGameId, row.token, oldIndex - 1]
        );
      }
    }
    await client.query(
      `UPDATE compost_game_tokens SET game_id = $2, player_index = $3 WHERE game_id = $1 AND token = $4`,
      [sourceGameId, targetGameId, target.players.length, movedToken]
    );
    if (eventMembership) {
      await client.query(
        `UPDATE compost_event_seats
            SET game_id=$2,player_id=$3,player_index=$4,ready=false,last_seen_at=NULL
          WHERE event_id=$1 AND game_id=$5 AND player_id=$6`,
        [eventMembership.eventId, targetGameId, movedPlayer.id, target.players.length, sourceGameId, playerId],
      );
      await client.query(
        `UPDATE compost_event_seats SET player_index=player_index-1
          WHERE event_id=$1 AND game_id=$2 AND player_index>$3`,
        [eventMembership.eventId, sourceGameId, playerIndex],
      );
    }
    await storeGame(nextSource, client);
    await storeGame(nextTarget, client);
    commitAttempted = true;
    await client.query("COMMIT");
    committed = true;
    recordAuthoritativeGameChange(sourceGameId);
    recordAuthoritativeGameChange(targetGameId);
    gameStoreCache.setState(nextSource);
    gameStoreCache.setState(nextTarget);
    if (eventMembership) {
      gameStoreCache.markEventMembership(sourceGameId, true);
      gameStoreCache.markEventMembership(targetGameId, true);
    }
    const sourceMap = new Map(gameStoreCache.getTokenIndex(sourceGameId) ?? []);
    sourceMap.delete(movedToken);
    for (const [key, index] of sourceMap) if (index > playerIndex) sourceMap.set(key, index - 1);
    removeSseSeat(sourceGameId, playerIndex, true);
    revokeSseToken(sourceGameId, movedToken);
    publishTokenIndex(sourceGameId, sourceMap);
    const targetMap = new Map(gameStoreCache.getTokenIndex(targetGameId) ?? []);
    targetMap.set(movedToken, target.players.length);
    publishTokenIndex(targetGameId, targetMap);
    return { source: nextSource, target: nextTarget, token: movedToken };
  } catch (error) {
    if (committed) throw safelyClassifyFailedTransaction(error, false);
    const rollbackSucceeded = await rollbackClientTransaction(client);
    throw safelyClassifyFailedTransaction(error, rollbackSucceeded && !commitAttempted);
  } finally {
    if (ownsClient && !destroyedClients.has(client)) client.release();
  }
}

/** Look up the seat token for a given player index (host recovery). */
export async function getTokenForPlayerIndex(
  gameId: string,
  playerIndex: number,
  client: PgQueryable = pool,
): Promise<string | null> {
  const result = await client.query(
    `SELECT token FROM compost_game_tokens
     WHERE game_id = $1 AND player_index = $2`,
    [gameId, playerIndex]
  );
  return (result.rows[0]?.token as string | undefined) ?? null;
}

export async function getPlayerIndexForToken(
  gameId: string,
  token: string,
  client?: PgQueryable,
): Promise<number | null> {
  const queryable = client ?? pool;
  const canCache = queryable === pool;
  const cached = canCache ? gameStoreCache.getTokenIndex(gameId)?.get(token) : undefined;
  if (cached !== undefined) {
    repairUnknownSseSeat(gameId, token, cached);
    return cached;
  }
  const read = canCache ? gameStoreCache.beginRead(gameId) : undefined;
  try {
    const result = await queryable.query(
      `SELECT player_index FROM compost_game_tokens
       WHERE game_id = $1 AND token = $2`,
      [gameId, token]
    );
    if (result.rows.length === 0) return null;
    const playerIndex = Number(result.rows[0].player_index);
    repairUnknownSseSeat(gameId, token, playerIndex);
    if (read) {
      const eventMembership = gameStoreCache.knowsEventMembership(gameId)
        ? undefined
        : await isGameEventMember(gameId, queryable);
      gameStoreCache.publishIfCurrent(read, () => {
        if (eventMembership !== undefined) gameStoreCache.markEventMembership(gameId, eventMembership);
        const nextIndexMap = new Map(gameStoreCache.getTokenIndex(gameId) ?? []);
        nextIndexMap.set(token, playerIndex);
        publishTokenIndex(gameId, nextIndexMap);
      });
    }
    return playerIndex;
  } finally {
    if (read) gameStoreCache.finishRead(read);
  }
}

export async function removePlayerTokenByIndex(
  gameId: string,
  removedIndex: number,
  client: PgQueryable = pool,
): Promise<string | null> {
  // Get the token being removed so we can send a kick event
  const findResult = await client.query(
    `SELECT token FROM compost_game_tokens
     WHERE game_id = $1 AND player_index = $2`,
    [gameId, removedIndex]
  );
  const removedToken: string | null = findResult.rows[0]?.token ?? null;

  try {
    await client.query(
      `DELETE FROM compost_game_tokens
       WHERE game_id = $1 AND player_index = $2`,
      [gameId, removedIndex]
    );

    await client.query(
      `UPDATE compost_game_tokens
       SET player_index = player_index - 1
       WHERE game_id = $1 AND player_index > $2`,
      [gameId, removedIndex]
    );
  } catch (error) {
    // A delete can commit before the following index-shift statement fails.
    // Fail closed until surviving credentials are resolved again.
    if (removedToken) revokeSseToken(gameId, removedToken);
    for (const connection of sseClientsByToken.get(gameId)?.values() ?? []) {
      connection.playerIndex = undefined;
    }
    recordUncachedGameChange(gameId, false);
    throw error;
  }

  // Mutate a private copy only after every durable statement has succeeded.
  removeSseSeat(gameId, removedIndex, true);
  if (removedToken) revokeSseToken(gameId, removedToken);
  if (client !== pool) {
    recordUncachedGameChange(gameId, false);
  } else {
    recordAuthoritativeGameChange(gameId);
    const tokenMap = new Map(gameStoreCache.getTokenIndex(gameId) ?? []);
    if (removedToken) tokenMap.delete(removedToken);
    for (const [tok, idx] of tokenMap) {
      if (idx > removedIndex) tokenMap.set(tok, idx - 1);
    }
    publishTokenIndex(gameId, tokenMap);
  }

  return removedToken;
}

/** Revoke a permanently replaced seat without shifting any other seat indexes. Caller holds the game lock. */
export async function revokeSeatTokens(gameId: string, index: number, client: PgClient): Promise<string[]> {
  try {
    const result = await client.query(
      `DELETE FROM compost_game_tokens WHERE game_id=$1 AND player_index=$2 RETURNING token`, [gameId, index]);
    removeSseSeat(gameId, index, false);
    for (const row of result.rows) revokeSseToken(gameId, row.token);
    recordUncachedGameChange(gameId, false);
    return result.rows.map(row => row.token as string);
  } catch (error) {
    // The server may have committed a delete before the connection failed.
    removeSseSeat(gameId, index, false);
    recordUncachedGameChange(gameId, false);
    throw error;
  }
}

export async function removeEventWaitingPlayer(
  gameId: string,
  playerId: string,
  heldClient?: PgClient,
): Promise<{ state: GameState; removedToken: string | null } | null> {
  const ownsClient = !heldClient;
  const client = heldClient ?? await connectDatabaseClient();
  let commitAttempted = false;
  let committed = false;
  try {
    await client.query("BEGIN");
    const game = await client.query(`SELECT state FROM compost_games WHERE game_id=$1 FOR UPDATE`, [gameId]);
    if (!game.rows.length) { await client.query("ROLLBACK"); return null; }
    const state = (typeof game.rows[0].state === "string" ? JSON.parse(game.rows[0].state) : game.rows[0].state) as GameState;
    let eventId = state.eventId;
    if (!eventId) {
      const linked = await eventLookupInTransaction(client,
        () => client.query(`SELECT event_id FROM compost_event_tables WHERE game_id=$1`, [gameId]));
      eventId = linked?.rows[0]?.event_id;
    }
    if (!eventId || state.phase !== "waiting") { await client.query("ROLLBACK"); return null; }
    const removedIndex = state.players.findIndex((player) => player.id === playerId);
    if (removedIndex < 0) { await client.query("ROLLBACK"); return null; }
    const tokenRows = await client.query(
      `SELECT token,player_index FROM compost_game_tokens WHERE game_id=$1 FOR UPDATE`, [gameId],
    );
    const tokenRow = tokenRows.rows.find((row) => Number(row.player_index) === removedIndex);
    const nextState = { ...state, players: state.players.filter((player) => player.id !== playerId) };
    if (tokenRow) {
      await client.query(`DELETE FROM compost_game_tokens WHERE game_id=$1 AND token=$2`, [gameId, tokenRow.token]);
    }
    for (const row of tokenRows.rows) {
      const index = Number(row.player_index);
      if (index > removedIndex) {
        await client.query(`UPDATE compost_game_tokens SET player_index=$3 WHERE game_id=$1 AND token=$2`,
          [gameId, row.token, -400000 - index]);
      }
    }
    for (const row of tokenRows.rows) {
      const index = Number(row.player_index);
      if (index > removedIndex) {
        await client.query(`UPDATE compost_game_tokens SET player_index=$3 WHERE game_id=$1 AND token=$2`,
          [gameId, row.token, index - 1]);
      }
    }
    await client.query(
      `DELETE FROM compost_event_seats WHERE event_id=$1 AND game_id=$2 AND player_id=$3`,
      [eventId, gameId, playerId],
    );
    await client.query(
      `UPDATE compost_event_seats SET player_index=player_index-1 WHERE event_id=$1 AND game_id=$2 AND player_index>$3`,
      [eventId, gameId, removedIndex],
    );
    await storeGame(nextState, client);
    commitAttempted = true;
    await client.query("COMMIT");
    committed = true;
    recordAuthoritativeGameChange(gameId);
    gameStoreCache.setState(nextState);
    gameStoreCache.markEventMembership(gameId, true);
    removeSseSeat(gameId, removedIndex, true);
    if (tokenRow) revokeSseToken(gameId, tokenRow.token);
    const tokenMap = new Map(gameStoreCache.getTokenIndex(gameId) ?? []);
    if (tokenMap) {
      if (tokenRow) tokenMap.delete(tokenRow.token);
      for (const [token, index] of tokenMap) if (index > removedIndex) tokenMap.set(token, index - 1);
      publishTokenIndex(gameId, tokenMap);
    }
    return { state: nextState, removedToken: (tokenRow?.token as string | undefined) ?? null };
  } catch (error) {
    if (committed) throw safelyClassifyFailedTransaction(error, false);
    const rollbackSucceeded = await rollbackClientTransaction(client);
    throw safelyClassifyFailedTransaction(error, rollbackSucceeded && !commitAttempted);
  } finally {
    if (ownsClient && !destroyedClients.has(client)) client.release();
  }
}

/**
 * Facilitator player removal/takeover. The room state and its seat credential
 * are changed under one row-locked transaction so a kicked token cannot be
 * used to rejoin between the state update and token revocation.
 */
export async function kickFacilitatedPlayer(
  gameId: string,
  playerId: string,
  hostToken: string,
  facilitatorId: string,
  heldClient?: PgClient,
): Promise<{ state: GameState; removedToken: string | null; active: boolean } | null> {
  const ownsClient = !heldClient;
  const client = heldClient ?? await connectDatabaseClient();
  let commitAttempted = false;
  let committed = false;
  try {
    await client.query("BEGIN");
    const gameResult = await client.query(
      `SELECT state FROM compost_games WHERE game_id = $1 FOR UPDATE`,
      [gameId]
    );
    if (!gameResult.rows.length) {
      await client.query("ROLLBACK");
      return null;
    }
    const state = (typeof gameResult.rows[0].state === "string"
      ? JSON.parse(gameResult.rows[0].state)
      : gameResult.rows[0].state) as GameState;
    if (state.mode !== "facilitated" || state.facilitatorId !== facilitatorId) {
      await client.query("ROLLBACK");
      return null;
    }

    const tokenRows = await client.query(
      `SELECT token, player_index FROM compost_game_tokens WHERE game_id = $1 FOR UPDATE`,
      [gameId]
    );
    const hostIndex = state.hostIsSpectator === true ? -1 : 0;
    const hostRow = tokenRows.rows.find((row) =>
      row.token === hostToken && Number(row.player_index) === hostIndex
    );
    if (!hostRow) {
      await client.query("ROLLBACK");
      return null;
    }

    const removedIndex = state.players.findIndex((player) => player.id === playerId);
    const protectedHostIndex = state.hostIsSpectator === true ? -1 : 0;
    const target = state.players[removedIndex];
    if (!target || removedIndex === protectedHostIndex || (target.isBot && state.phase !== "game_over")) {
      await client.query("ROLLBACK");
      return null;
    }

    const removedTokenRow = tokenRows.rows.find((row) =>
      Number(row.player_index) === removedIndex
    );
    const removedToken = (removedTokenRow?.token as string | undefined) ?? null;
    let nextState: GameState;
    const active = !["waiting", "game_over"].includes(state.phase);

    if (!active) {
      nextState = updateRoundRoster(state, state.players.filter((player) => player.id !== playerId));
      if (removedTokenRow) {
        await client.query(
          `DELETE FROM compost_game_tokens WHERE game_id = $1 AND token = $2`,
          [gameId, removedTokenRow.token]
        );
      }
      // Temporarily move higher seats to avoid a uniqueness collision while
      // shifting them down into the vacated index.
      for (const row of tokenRows.rows) {
        const index = Number(row.player_index);
        if (index > removedIndex) {
          await client.query(
            `UPDATE compost_game_tokens SET player_index = $3 WHERE game_id = $1 AND token = $2`,
            [gameId, row.token, -300000 - index]
          );
        }
      }
      for (const row of tokenRows.rows) {
        const index = Number(row.player_index);
        if (index > removedIndex) {
          await client.query(
            `UPDATE compost_game_tokens SET player_index = $3 WHERE game_id = $1 AND token = $2`,
            [gameId, row.token, index - 1]
          );
        }
      }
    } else {
      // Only actual in-progress game phases can be converted to bots.
      if (!["draw", "play", "effect_resolution", "end_turn"].includes(state.phase)) {
        await client.query("ROLLBACK");
        return null;
      }
      nextState = runBotTurnsIfNeeded(takeOverPlayerAsBot(state, playerId));
      if (removedTokenRow) {
        await client.query(
          `DELETE FROM compost_game_tokens WHERE game_id = $1 AND token = $2`,
          [gameId, removedTokenRow.token]
        );
      }
    }

    let eventId = state.eventId;
    if (!eventId) {
      const linkedEvent = await eventLookupInTransaction(client,
        () => client.query(`SELECT event_id FROM compost_event_tables WHERE game_id=$1`, [gameId]));
      eventId = linkedEvent?.rows[0]?.event_id;
    }
    if (eventId) {
      await client.query(
        `DELETE FROM compost_event_seats WHERE event_id=$1 AND game_id=$2 AND player_id=$3`,
        [eventId, gameId, playerId],
      );
      if (!active) {
        await client.query(
          `UPDATE compost_event_seats SET player_index=player_index-1
           WHERE event_id=$1 AND game_id=$2 AND player_index>$3`,
          [eventId, gameId, removedIndex],
        );
      }
    }
    await storeGame(nextState, client);
    commitAttempted = true;
    await client.query("COMMIT");
    committed = true;

    recordAuthoritativeGameChange(gameId);
    gameStoreCache.setState(nextState);
    if (eventId) gameStoreCache.markEventMembership(gameId, true);
    removeSseSeat(gameId, removedIndex, !active);
    if (removedToken) revokeSseToken(gameId, removedToken);
    const tokenMap = new Map(gameStoreCache.getTokenIndex(gameId) ?? []);
    if (tokenMap) {
      if (removedToken) tokenMap.delete(removedToken);
      if (!active) {
        for (const [token, index] of tokenMap) {
          if (index > removedIndex) tokenMap.set(token, index - 1);
        }
      }
      publishTokenIndex(gameId, tokenMap);
    }
    return { state: nextState, removedToken, active };
  } catch (error) {
    if (committed) throw safelyClassifyFailedTransaction(error, false);
    const rollbackSucceeded = await rollbackClientTransaction(client);
    throw safelyClassifyFailedTransaction(error, rollbackSucceeded && !commitAttempted);
  } finally {
    if (ownsClient && !destroyedClients.has(client)) client.release();
  }
}

// ── SSE (in-memory only) ──────────────────────────────────────────────────────

export function addSseClient(
  gameId: string, token: string, res: Response, playerIndex?: number, playerId?: string,
): void {
  if (!sseClientsByToken.has(gameId)) {
    sseClientsByToken.set(gameId, new Map());
  }
  sseClientsByToken.get(gameId)!.set(token, { res, playerIndex, playerId, revoked: false });
}

export function removeSseClient(gameId: string, token: string, res?: Response): void {
  const clients = sseClientsByToken.get(gameId);
  if (!res || clients?.get(token)?.res === res) clients?.delete(token);
}

export function getConnectedPlayerIds(gameId: string): string[] {
  return [...new Set([...(sseClientsByToken.get(gameId)?.values() ?? [])]
    .filter(connection => !connection.revoked && connection.playerId)
    .map(connection => connection.playerId!))];
}

export function sendKickedEvent(gameId: string, token: string): void {
  const clients = sseClientsByToken.get(gameId);
  if (!clients) return;
  const res = clients.get(token)?.res;
  if (res) {
    try {
      res.write(`event: kicked\ndata: {}\n\n`);
      (res as any).flush?.();
      res.end();
    } catch {}
    clients.delete(token);
  }
}

export function sendRoomTransferEvent(
  sourceGameId: string,
  token: string,
  gameId: string,
  targetToken: string
): void {
  const clients = sseClientsByToken.get(sourceGameId);
  const res = clients?.get(token)?.res;
  if (!res) return;
  try {
    res.write(`event: room_transfer\ndata: ${JSON.stringify({ gameId, targetToken })}\n\n`);
    (res as any).flush?.();
    res.end();
  } catch {}
  clients?.delete(token);
}

export async function sendNudgeEvent(gameId: string, targetPlayerIndex: number, fromName: string, client: PgQueryable = pool): Promise<void> {
  const result = await client.query(
    `SELECT token FROM compost_game_tokens WHERE game_id = $1 AND player_index = $2`,
    [gameId, targetPlayerIndex]
  );
  if (result.rows.length === 0) return;
  const targetToken = result.rows[0].token as string;
  const clients = sseClientsByToken.get(gameId);
  if (!clients) return;
  const connection = clients.get(targetToken);
  const res = connection?.revoked ? undefined : connection?.res;
  if (!res) return;
  try {
    res.write(`event: nudge\ndata: ${JSON.stringify({ from: fromName })}\n\n`);
  } catch {}
}

export function broadcastToGame(
  gameId: string,
  state: GameState,
  serializeFn: (state: GameState, viewerIndex?: number) => object,
  heldClient?: PgClient,
): void {
  if (heldClient) {
    const pending = deferredBroadcastsByClient.get(heldClient) ?? new Set<string>();
    pending.add(gameId);
    deferredBroadcastsByClient.set(heldClient, pending);
  } else {
    for (const listener of gameBroadcastListeners) {
      try { listener(gameId); } catch { /* a stream subscriber must not break gameplay broadcasts */ }
    }
  }
  const clients = sseClientsByToken.get(gameId);
  if (!clients || clients.size === 0) return;

  for (const [token, connection] of clients) {
    if (connection.revoked) continue;
    const { res, playerIndex, playerId } = connection;
    const seatKnown = playerIndex === -1 ||
      (playerIndex !== undefined && Number.isInteger(playerIndex) && playerIndex >= 0 &&
        !!state.players[playerIndex] && (!playerId || state.players[playerIndex].id === playerId));
    try {
      if (!seatKnown) {
        res.write(`event: refresh\ndata: {}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify(serializeFn(state, playerIndex))}\n\n`);
      }
      (res as any).flush?.();
    } catch {
      clients.delete(token);
    }
  }
}
