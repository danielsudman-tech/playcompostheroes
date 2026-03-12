import { GameState } from "./gameEngine.js";

// In-memory store for game sessions
const games = new Map<string, GameState>();

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export function storeGame(state: GameState): void {
  games.set(state.gameId, state);
}

export function getGame(gameId: string): GameState | undefined {
  return games.get(gameId);
}

export function createGameId(): string {
  return generateId();
}
