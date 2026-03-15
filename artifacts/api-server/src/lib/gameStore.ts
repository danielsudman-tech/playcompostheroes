import { pool } from "@workspace/db";
import { GameState } from "./gameEngine.js";
import type { Response } from "express";

// ── In-memory only: live SSE connections (can't persist HTTP streams) ──────────
const sseClientsByToken = new Map<string, Map<string, Response>>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function generateToken(): string {
  return generateId() + generateId() + generateId();
}

export function createGameId(): string {
  return generateId();
}

// ── Game state ────────────────────────────────────────────────────────────────

export async function storeGame(state: GameState): Promise<void> {
  await pool.query(
    `INSERT INTO compost_games (game_id, state, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (game_id) DO UPDATE
       SET state = EXCLUDED.state,
           updated_at = NOW()`,
    [state.gameId, JSON.stringify(state)]
  );
}

export async function getGame(gameId: string): Promise<GameState | undefined> {
  const result = await pool.query(
    `SELECT state FROM compost_games WHERE game_id = $1`,
    [gameId]
  );
  if (result.rows.length === 0) return undefined;
  const row = result.rows[0];
  return (typeof row.state === "string" ? JSON.parse(row.state) : row.state) as GameState;
}

// ── Password ──────────────────────────────────────────────────────────────────

export async function setGamePassword(gameId: string, password: string): Promise<void> {
  await pool.query(
    `UPDATE compost_games SET password = $2 WHERE game_id = $1`,
    [gameId, password]
  );
}

export async function gameHasPassword(gameId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT password FROM compost_games WHERE game_id = $1`,
    [gameId]
  );
  if (result.rows.length === 0) return false;
  return result.rows[0].password != null;
}

export async function checkGamePassword(gameId: string, password: string): Promise<boolean> {
  const result = await pool.query(
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

// ── Tokens ────────────────────────────────────────────────────────────────────

export async function claimSlot(
  gameId: string,
  existingToken?: string
): Promise<{ token: string; playerIndex: number } | null> {
  const game = await getGame(gameId);
  if (!game) return null;

  // Check if existing token is valid
  if (existingToken) {
    const check = await pool.query(
      `SELECT player_index FROM compost_game_tokens
       WHERE game_id = $1 AND token = $2`,
      [gameId, existingToken]
    );
    if (check.rows.length > 0) {
      return { token: existingToken, playerIndex: check.rows[0].player_index };
    }
  }

  // Find next unclaimed player index
  const takenResult = await pool.query(
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
  await pool.query(
    `INSERT INTO compost_game_tokens (game_id, token, player_index)
     VALUES ($1, $2, $3)`,
    [gameId, token, nextIndex]
  );
  return { token, playerIndex: nextIndex };
}

export async function getPlayerIndexForToken(
  gameId: string,
  token: string
): Promise<number | null> {
  const result = await pool.query(
    `SELECT player_index FROM compost_game_tokens
     WHERE game_id = $1 AND token = $2`,
    [gameId, token]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].player_index as number;
}

export async function removePlayerTokenByIndex(
  gameId: string,
  removedIndex: number
): Promise<string | null> {
  // Get the token being removed so we can send a kick event
  const findResult = await pool.query(
    `SELECT token FROM compost_game_tokens
     WHERE game_id = $1 AND player_index = $2`,
    [gameId, removedIndex]
  );
  const removedToken: string | null = findResult.rows[0]?.token ?? null;

  // Delete the removed player's token
  await pool.query(
    `DELETE FROM compost_game_tokens
     WHERE game_id = $1 AND player_index = $2`,
    [gameId, removedIndex]
  );

  // Shift down all higher indices
  await pool.query(
    `UPDATE compost_game_tokens
     SET player_index = player_index - 1
     WHERE game_id = $1 AND player_index > $2`,
    [gameId, removedIndex]
  );

  return removedToken;
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
    } catch {}
    clients.delete(token);
  }
}

export function broadcastToGame(
  gameId: string,
  state: GameState,
  serializeFn: (state: GameState, viewerIndex?: number) => object
): void {
  const clients = sseClientsByToken.get(gameId);
  if (!clients || clients.size === 0) return;

  // Token → player index must be fetched async, but broadcast is fire-and-forget.
  // We load the token map once and broadcast synchronously to all live connections.
  pool
    .query(
      `SELECT token, player_index FROM compost_game_tokens WHERE game_id = $1`,
      [gameId]
    )
    .then((result) => {
      const tokenMap = new Map<string, number>(
        result.rows.map((r) => [r.token as string, r.player_index as number])
      );
      for (const [token, res] of clients) {
        const playerIndex = tokenMap.get(token);
        const payload = serializeFn(state, playerIndex);
        try {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch {
          clients.delete(token);
        }
      }
    })
    .catch(() => {
      // If DB lookup fails, broadcast without player filtering
      for (const [, res] of clients) {
        const payload = serializeFn(state);
        try {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch {}
      }
    });
}
