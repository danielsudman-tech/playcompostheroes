import { GameState } from "./gameEngine.js";
import type { Response } from "express";

const games = new Map<string, GameState>();

// gameId -> plain-text password (optional)
const gamePasswords = new Map<string, string>();

// gameId -> Map<token -> playerIndex>
const gameTokens = new Map<string, Map<string, number>>();

// gameId -> Map<token -> SSE Response>
const sseClientsByToken = new Map<string, Map<string, Response>>();

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function generateToken(): string {
  return generateId() + generateId() + generateId();
}

export function storeGame(state: GameState): void {
  games.set(state.gameId, state);
}

export function setGamePassword(gameId: string, password: string): void {
  gamePasswords.set(gameId, password);
}

export function gameHasPassword(gameId: string): boolean {
  return gamePasswords.has(gameId);
}

export function checkGamePassword(gameId: string, password: string): boolean {
  const stored = gamePasswords.get(gameId);
  if (stored === undefined) return true; // no password set
  return stored === password;
}

export function getGame(gameId: string): GameState | undefined {
  return games.get(gameId);
}

export function createGameId(): string {
  return generateId();
}

export function claimSlot(
  gameId: string,
  existingToken?: string
): { token: string; playerIndex: number } | null {
  const game = games.get(gameId);
  if (!game) return null;

  let tokens = gameTokens.get(gameId);
  if (!tokens) {
    tokens = new Map();
    gameTokens.set(gameId, tokens);
  }

  if (existingToken && tokens.has(existingToken)) {
    return { token: existingToken, playerIndex: tokens.get(existingToken)! };
  }

  const claimedIndices = new Set(tokens.values());
  let nextIndex = -1;
  for (let i = 0; i < game.players.length; i++) {
    if (!claimedIndices.has(i)) {
      nextIndex = i;
      break;
    }
  }

  if (nextIndex === -1) return null;

  const token = generateToken();
  tokens.set(token, nextIndex);
  return { token, playerIndex: nextIndex };
}

export function getPlayerIndexForToken(
  gameId: string,
  token: string
): number | null {
  const tokens = gameTokens.get(gameId);
  if (!tokens) return null;
  const idx = tokens.get(token);
  return idx !== undefined ? idx : null;
}

export function addSseClient(gameId: string, token: string, res: Response): void {
  if (!sseClientsByToken.has(gameId)) {
    sseClientsByToken.set(gameId, new Map());
  }
  sseClientsByToken.get(gameId)!.set(token, res);
}

export function removeSseClient(gameId: string, token: string): void {
  sseClientsByToken.get(gameId)?.delete(token);
}

export function broadcastToGame(
  gameId: string,
  state: GameState,
  serializeFn: (state: GameState, viewerIndex?: number) => object
): void {
  const clients = sseClientsByToken.get(gameId);
  if (!clients || clients.size === 0) return;

  const tokens = gameTokens.get(gameId);
  for (const [token, res] of clients) {
    const playerIndex = tokens?.get(token);
    const payload = serializeFn(state, playerIndex);
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      clients.delete(token);
    }
  }
}
