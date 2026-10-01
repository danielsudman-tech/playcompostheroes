import { pool } from "@workspace/db";
import { GameState, runBotTurnsIfNeeded, takeOverPlayerAsBot } from "./gameEngine.js";
import type { Response } from "express";
import { randomBytes } from "node:crypto";

export type PgQueryResult = { rows: any[]; rowCount?: number | null };
export type PgQueryable = { query: (...args: any[]) => Promise<PgQueryResult> };
export type PgClient = PgQueryable & { release(error?: Error | boolean): void };

// ── In-memory only: live SSE connections (can't persist HTTP streams) ──────────
const sseClientsByToken = new Map<string, Map<string, Response>>();

// ── In-memory game state cache ────────────────────────────────────────────────
// Eliminates a DB read on every action — the DB remains the durable backup.
const gameStateCache = new Map<string, GameState>();

// ── In-memory token → player-index map per game ───────────────────────────────
// Eliminates a DB query on every SSE broadcast.
const tokenIndexCache = new Map<string, Map<string, number>>();
const gameBroadcastListeners = new Set<(gameId: string) => void>();
const deferredBroadcastsByClient = new WeakMap<PgClient, Set<string>>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function createGameId(): string {
  return generateId();
}

// ── Game state ────────────────────────────────────────────────────────────────

export async function storeGame(state: GameState, client: PgQueryable = pool): Promise<void> {
  // Stamp the finish time once, regardless of how the game ended (win or
  // manual end), so post-session summaries can show duration.
  if (state.phase === "game_over" && !state.endedAt) {
    state.endedAt = Date.now();
  }
  gameStateCache.set(state.gameId, state);
  await client.query(
    `INSERT INTO compost_games (game_id, state, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (game_id) DO UPDATE
       SET state = EXCLUDED.state,
           updated_at = NOW()`,
    [state.gameId, JSON.stringify(state)]
  );
}

/** Keep the durable transaction's committed state visible to normal game readers. */
export function updateGameStateCache(state: GameState): void {
  gameStateCache.set(state.gameId, state);
}

export function onGameBroadcast(listener: (gameId: string) => void): () => void {
  gameBroadcastListeners.add(listener);
  return () => gameBroadcastListeners.delete(listener);
}

export async function getGame(gameId: string, client?: PgQueryable): Promise<GameState | undefined> {
  if (!client && gameStateCache.has(gameId)) return gameStateCache.get(gameId);
  const result = await (client ?? pool).query(
    `SELECT state FROM compost_games WHERE game_id = $1`,
    [gameId]
  );
  if (result.rows.length === 0) return undefined;
  const row = result.rows[0];
  const state = (typeof row.state === "string" ? JSON.parse(row.state) : row.state) as GameState;
  gameStateCache.set(gameId, state);
  return state;
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

export async function reloadGameState(gameId: string, client: PgQueryable = pool): Promise<GameState | undefined> {
  const result = await client.query(`SELECT state FROM compost_games WHERE game_id=$1`, [gameId]);
  if (!result.rows.length) {
    gameStateCache.delete(gameId);
    tokenIndexCache.delete(gameId);
    return undefined;
  }
  const value = result.rows[0].state;
  const state = (typeof value === "string" ? JSON.parse(value) : value) as GameState;
  gameStateCache.set(gameId, state);
  const tokenRows = await client.query(`SELECT token,player_index FROM compost_game_tokens WHERE game_id=$1`, [gameId]);
  tokenIndexCache.set(gameId, new Map(tokenRows.rows.map((row: { token: string; player_index: number | string }) =>
    [row.token, Number(row.player_index)])));
  return state;
}

export async function acquireGameMutationLock(gameId: string): Promise<PgClient> {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query(`SELECT pg_advisory_lock(7419, hashtext($1))`, [gameId]);
    locked = true;
    await reloadGameState(gameId, client);
    return client;
  } catch (error) {
    if (locked) await client.query(`SELECT pg_advisory_unlock(7419, hashtext($1))`, [gameId]).catch(() => undefined);
    client.release();
    throw error;
  }
}

export async function releaseGameMutationLock(client: PgClient, gameId: string): Promise<void> {
  try {
    await client.query(`SELECT pg_advisory_unlock(7419, hashtext($1))`, [gameId]);
  } finally {
    client.release();
    flushDeferredBroadcasts(client);
  }
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

export async function withGameMutationLocks<T>(
  gameIds: string[],
  action: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const sortedGameIds = [...new Set(gameIds)].sort();
  try {
    if (sortedGameIds.length) {
      await client.query(
        `SELECT pg_advisory_lock(7419, hashtext(lock_targets.game_id))
           FROM (SELECT unnest($1::text[]) AS game_id ORDER BY game_id) AS lock_targets`,
        [sortedGameIds],
      );
    }
    for (const gameId of sortedGameIds) {
      await reloadGameState(gameId, client);
    }
    return await action(client);
  } finally {
    try {
      for (const gameId of [...sortedGameIds].reverse()) {
        await client.query(`SELECT pg_advisory_unlock(7419, hashtext($1))`, [gameId]);
      }
    } finally {
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
  if (!tokenIndexCache.has(gameId)) tokenIndexCache.set(gameId, new Map());
  tokenIndexCache.get(gameId)!.set(token, nextIndex);
  return { token, playerIndex: nextIndex };
}

/** Find the room currently owning a credential, for durable transfer recovery. */
export async function getGameIdForToken(token: string, client: PgQueryable = pool): Promise<string | null> {
  const result = await client.query(
    `SELECT game_id FROM compost_game_tokens WHERE token = $1 LIMIT 1`,
    [token]
  );
  return (result.rows[0]?.game_id as string | undefined) ?? null;
}

/** Mint the reserved, non-player token used by a new spectator-host session. */
export async function createSpectatorHostToken(gameId: string, client: PgQueryable = pool): Promise<string> {
  const token = generateToken();
  await client.query(
    `INSERT INTO compost_game_tokens (game_id, token, player_index) VALUES ($1, $2, -1)`,
    [gameId, token]
  );
  if (!tokenIndexCache.has(gameId)) tokenIndexCache.set(gameId, new Map());
  tokenIndexCache.get(gameId)!.set(token, -1);
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
  const client = heldClient ?? await pool.connect();
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
    await client.query(
      `UPDATE compost_games SET state = $2, updated_at = NOW() WHERE game_id = $1`,
      [gameId, JSON.stringify(nextState)]
    );
    await client.query("COMMIT");
    gameStateCache.set(gameId, nextState);
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
    tokenIndexCache.set(gameId, nextMap);
    return nextState;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (ownsClient) client.release();
  }
}

export async function transferWaitingPlayer(
  sourceGameId: string,
  targetGameId: string,
  playerId: string,
  heldClient?: PgClient,
): Promise<{ source: GameState; target: GameState; token: string } | null> {
  const ownsClient = !heldClient;
  const client = heldClient ?? await pool.connect();
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
    const validRoom = (g: GameState) => g.mode === "facilitated" && g.phase === "waiting";
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
    if (target.players.some((p) => p.id === playerId)) {
      const usedIds = new Set(target.players.map((p) => p.id));
      let uniqueId = `player_${generateId()}_${generateId()}`;
      while (usedIds.has(uniqueId)) uniqueId = `player_${generateId()}_${generateId()}`;
      movedPlayer = { ...movedPlayer, id: uniqueId };
    }
    const sourcePlayers = source.players.filter((p) => p.id !== playerId);
    const targetPlayers = [...target.players, movedPlayer];
    const nextSource = { ...source, players: sourcePlayers };
    const nextTarget = { ...target, players: targetPlayers };
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
    await client.query(
      `UPDATE compost_games SET state = $2, updated_at = NOW() WHERE game_id = $1`,
      [sourceGameId, JSON.stringify(nextSource)]
    );
    await client.query(
      `UPDATE compost_games SET state = $2, updated_at = NOW() WHERE game_id = $1`,
      [targetGameId, JSON.stringify(nextTarget)]
    );
    await client.query("COMMIT");
    gameStateCache.set(sourceGameId, nextSource);
    gameStateCache.set(targetGameId, nextTarget);
    const sourceMap = tokenIndexCache.get(sourceGameId) ?? new Map<string, number>();
    sourceMap.delete(movedToken);
    for (const [key, index] of sourceMap) if (index > playerIndex) sourceMap.set(key, index - 1);
    tokenIndexCache.set(sourceGameId, sourceMap);
    const targetMap = tokenIndexCache.get(targetGameId) ?? new Map<string, number>();
    targetMap.set(movedToken, target.players.length);
    tokenIndexCache.set(targetGameId, targetMap);
    return { source: nextSource, target: nextTarget, token: movedToken };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (ownsClient) client.release();
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
  const cached = tokenIndexCache.get(gameId)?.get(token);
  if (!client && cached !== undefined) return cached;
  const result = await (client ?? pool).query(
    `SELECT player_index FROM compost_game_tokens
     WHERE game_id = $1 AND token = $2`,
    [gameId, token]
  );
  if (result.rows.length === 0) return null;
  const playerIndex = result.rows[0].player_index as number;
  if (!tokenIndexCache.has(gameId)) tokenIndexCache.set(gameId, new Map());
  tokenIndexCache.get(gameId)!.set(token, playerIndex);
  return playerIndex;
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

  // Delete the removed player's token
  await client.query(
    `DELETE FROM compost_game_tokens
     WHERE game_id = $1 AND player_index = $2`,
    [gameId, removedIndex]
  );

  // Shift down all higher indices
  await client.query(
    `UPDATE compost_game_tokens
     SET player_index = player_index - 1
     WHERE game_id = $1 AND player_index > $2`,
    [gameId, removedIndex]
  );

  // Update in-memory token cache: remove the token, shift higher indices down
  const tokenMap = tokenIndexCache.get(gameId);
  if (tokenMap) {
    if (removedToken) tokenMap.delete(removedToken);
    for (const [tok, idx] of tokenMap) {
      if (idx > removedIndex) tokenMap.set(tok, idx - 1);
    }
  }

  return removedToken;
}

export async function removeEventWaitingPlayer(
  gameId: string,
  playerId: string,
  heldClient?: PgClient,
): Promise<{ state: GameState; removedToken: string | null } | null> {
  const ownsClient = !heldClient;
  const client = heldClient ?? await pool.connect();
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
    await client.query(`UPDATE compost_games SET state=$2,updated_at=NOW() WHERE game_id=$1`,
      [gameId, JSON.stringify(nextState)]);
    await client.query("COMMIT");
    gameStateCache.set(gameId, nextState);
    const tokenMap = tokenIndexCache.get(gameId);
    if (tokenMap) {
      if (tokenRow) tokenMap.delete(tokenRow.token);
      for (const [token, index] of tokenMap) if (index > removedIndex) tokenMap.set(token, index - 1);
    }
    return { state: nextState, removedToken: (tokenRow?.token as string | undefined) ?? null };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (ownsClient) client.release();
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
  const client = heldClient ?? await pool.connect();
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
    if (state.mode !== "facilitated" || state.facilitatorId !== facilitatorId ||
        state.phase === "game_over") {
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
    if (!target || removedIndex === protectedHostIndex || target.isBot) {
      await client.query("ROLLBACK");
      return null;
    }

    const removedTokenRow = tokenRows.rows.find((row) =>
      Number(row.player_index) === removedIndex
    );
    const removedToken = (removedTokenRow?.token as string | undefined) ?? null;
    let nextState: GameState;
    const active = state.phase !== "waiting";

    if (!active) {
      nextState = {
        ...state,
        players: state.players.filter((player) => player.id !== playerId),
      };
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
    await client.query(
      `UPDATE compost_games SET state = $2, updated_at = NOW() WHERE game_id = $1`,
      [gameId, JSON.stringify(nextState)]
    );
    await client.query("COMMIT");

    gameStateCache.set(gameId, nextState);
    const tokenMap = tokenIndexCache.get(gameId);
    if (tokenMap) {
      if (removedToken) tokenMap.delete(removedToken);
      if (!active) {
        for (const [token, index] of tokenMap) {
          if (index > removedIndex) tokenMap.set(token, index - 1);
        }
      }
    }
    return { state: nextState, removedToken, active };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (ownsClient) client.release();
  }
}

// ── SSE (in-memory only) ──────────────────────────────────────────────────────

export function addSseClient(gameId: string, token: string, res: Response): void {
  if (!sseClientsByToken.has(gameId)) {
    sseClientsByToken.set(gameId, new Map());
  }
  sseClientsByToken.get(gameId)!.set(token, res);
}

export function removeSseClient(gameId: string, token: string): void {
  sseClientsByToken.get(gameId)?.delete(token);
}

export function sendKickedEvent(gameId: string, token: string): void {
  const clients = sseClientsByToken.get(gameId);
  if (!clients) return;
  const res = clients.get(token);
  if (res) {
    try {
      res.write(`event: kicked\ndata: {}\n\n`);
      (res as any).flush?.();
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
  const res = clients?.get(token);
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
  const res = clients.get(targetToken);
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

  const tokenMap = tokenIndexCache.get(gameId);
  for (const [token, res] of clients) {
    const playerIndex = tokenMap?.get(token);
    const payload = serializeFn(state, playerIndex);
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      (res as any).flush?.();
    } catch {
      clients.delete(token);
    }
  }
}
