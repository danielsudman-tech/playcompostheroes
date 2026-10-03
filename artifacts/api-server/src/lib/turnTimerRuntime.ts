import {
  registerGameClock, withGameMutationLocks, getGame, storeGame, broadcastToGame,
  type PgQueryable, type PgClient,
} from "./gameStore.js";
import { expiredClock, expireTurnClock } from "./turnClock.js";
import type { GameState } from "./gameEngine.js";
import { serializeState } from "../routes/game.js";

const timers = new Map<string, ReturnType<typeof setTimeout>>();
export function disarmTurnTimer(gameId: string): void {
  const timer = timers.get(gameId);
  if (timer) clearTimeout(timer);
  timers.delete(gameId);
}
export function armTurnTimer(state: GameState): void {
  disarmTurnTimer(state.gameId);
  if (state.paused || state.turnDeadlineAt == null || !state.turnTimerSeconds) return;
  const key = state.turnDeadlineKey!;
  const deadline = state.turnDeadlineAt;
  const timer = setTimeout(() => {
    timers.delete(state.gameId);
    void withGameMutationLocks([state.gameId], async client => {
      const latest = await getGame(state.gameId, client);
      if (!latest) return;
      const next = expireTurnClock(latest, key, deadline);
      if (next === latest) { armTurnTimer(latest); return; }
      await storeGame(next, client);
      broadcastToGame(next.gameId, next, serializeState, client);
    }).catch(error => {
      console.error("[turn timer] expiry failed", error instanceof Error ? error.message : "unknown");
      // A bounded retry timer is not a client poll. Durable deadlines remain authoritative.
      const retry = setTimeout(() => armTurnTimer({ ...state, turnDeadlineAt: Date.now() + 1000 }), 1000);
      retry.unref();
      timers.set(state.gameId, retry);
    });
  }, Math.max(1, Math.min(2147483647, deadline - Date.now())));
  timer.unref();
  timers.set(state.gameId, timer);
}

async function readClock(state: GameState, client?: PgQueryable): Promise<GameState> {
  if (!expiredClock(state, Date.now())) { armTurnTimer(state); return state; }
  if (!client) {
    return withGameMutationLocks([state.gameId], async held => (await getGame(state.gameId, held)) ?? state);
  }
  const next = expireTurnClock(state, state.turnDeadlineKey!, state.turnDeadlineAt!);
  if (next !== state) {
    await storeGame(next, client);
    broadcastToGame(next.gameId, next, serializeState, client as PgClient);
  }
  return next;
}

registerGameClock({ arm: armTurnTimer, read: readClock, remove: disarmTurnTimer });