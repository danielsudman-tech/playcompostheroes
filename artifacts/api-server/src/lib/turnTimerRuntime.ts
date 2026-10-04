import {
  registerGameClock, withGameMutationLocks, getGame, storeGame, broadcastToGame,
  getCachedGameState,
  type PgQueryable, type PgClient,
} from "./gameStore.js";
import { expiredClock, expireTurnClock } from "./turnClock.js";
import type { GameState } from "./gameEngine.js";
import { serializeState } from "../routes/game.js";

export const MAX_TIMER_ATTEMPTS = 3;

/** Scheduling is injectable so retry exhaustion can be tested without real waits. */
export function createTurnTimerScheduler(deps: {
  run: (state: GameState) => Promise<void>;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
  report?: (error: unknown) => void;
}) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const identities = new Map<string, string>();
  const failures = new Map<string, number>();
  const inFlight = new Map<string, string>();
  const schedule = deps.schedule ?? setTimeout;
  const cancel = deps.cancel ?? clearTimeout;
  function clearTimer(gameId: string) {
    const timer = timers.get(gameId);
    if (timer) cancel(timer);
    timers.delete(gameId);
  }
  function disarm(gameId: string) {
    clearTimer(gameId);
    identities.delete(gameId);
    failures.delete(gameId);
  }
  function arm(state: GameState, authoritative = true) {
    if (!authoritative && timers.has(state.gameId)) return;
    clearTimer(state.gameId);
    if (state.paused || state.turnDeadlineAt == null || !state.turnTimerSeconds) {
      disarm(state.gameId);
      return;
    }
    const identity = `${state.turnDeadlineKey}:${state.turnDeadlineAt}`;
    if (inFlight.get(state.gameId) === identity) return;
    if (identities.get(state.gameId) !== identity) failures.delete(state.gameId);
    identities.set(state.gameId, identity);
    if ((failures.get(state.gameId) ?? 0) >= MAX_TIMER_ATTEMPTS) return;
    const fire = () => {
      if (identities.get(state.gameId) !== identity || inFlight.has(state.gameId) ||
        (failures.get(state.gameId) ?? 0) >= MAX_TIMER_ATTEMPTS) return;
      timers.delete(state.gameId);
      inFlight.set(state.gameId, identity);
      void deps.run(state).catch(error => {
        // A failure from a superseded timer must not overwrite a newer timer.
        if (identities.get(state.gameId) !== identity) return;
        const count = (failures.get(state.gameId) ?? 0) + 1;
        failures.set(state.gameId, count);
        deps.report?.(error);
        clearTimer(state.gameId);
        if (count >= MAX_TIMER_ATTEMPTS) return;
        // Keep the ORIGINAL durable deadline/key for retries.
        const retry = schedule(fire, 1000);
        retry.unref();
        timers.set(state.gameId, retry);
      }).finally(() => {
        if (inFlight.get(state.gameId) === identity) inFlight.delete(state.gameId);
      });
    };
    const timer = schedule(fire, Math.max(1, Math.min(2147483647, state.turnDeadlineAt - Date.now())));
    timer.unref();
    timers.set(state.gameId, timer);
  }
  return { arm, disarm };
}

const scheduler = createTurnTimerScheduler({
  async run(state) {
    await withGameMutationLocks([state.gameId], async client => {
      const latest = await getGame(state.gameId, client);
      if (!latest) { disarmTurnTimer(state.gameId); return; }
      const next = expireTurnClock(latest, state.turnDeadlineKey!, state.turnDeadlineAt!);
      if (next === latest) { armTurnTimer(latest); return; }
      await storeGame(next, client);
      broadcastToGame(next.gameId, next, serializeState, client);
    });
  },
  report(error) { console.error("[turn timer] expiry failed", error instanceof Error ? error.message : "unknown"); },
});
export const armTurnTimer = scheduler.arm;
export const disarmTurnTimer = scheduler.disarm;

async function readClock(state: GameState, client?: PgQueryable): Promise<GameState> {
  if (!expiredClock(state, Date.now())) {
    armTurnTimer(getCachedGameState(state.gameId) ?? state, false);
    return state;
  }
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