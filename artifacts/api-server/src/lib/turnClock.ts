import { drawCardAction, endTurn, resolveDecision, runBotTurnsIfNeeded, type GameState } from "./gameEngine.js";
import { buildAutoResolveData } from "./autoResolve.js";
import { createHash } from "node:crypto";
import { recordMissedTurn } from "./playerCover.js";
import { addSystemUpdate } from "./systemUpdates.js";

export const TURN_TIMER_VALUES = [0, 30, 60, 90, 120] as const;
export const validTurnTimer = (value: unknown): value is number =>
  typeof value === "number" && TURN_TIMER_VALUES.includes(value as typeof TURN_TIMER_VALUES[number]);

export function requiredActor(state: GameState): string | undefined {
  return state.pendingDecision?.playerId ?? state.players[state.currentPlayerIndex]?.id;
}

export function clockIdentity(state: GameState): string {
  const decision = state.pendingDecision;
  return createHash("sha256").update(JSON.stringify([state.turnNumber, state.turnSequence ?? 0, requiredActor(state),
    decision ? [decision.type, decision.cardId] : "turn"])).digest("hex");
}

export function syncTurnClock(state: GameState, now = Date.now()): GameState {
  const seconds = state.mode === "standalone" || state.mode === "facilitator" ? 0 : state.turnTimerSeconds ?? 0;
  if (!seconds || state.phase === "waiting" || state.phase === "setup" || state.phase === "game_over") {
    return { ...state, turnTimerSeconds: seconds, turnDeadlineAt: null, turnDeadlineKey: null, turnTimerActorKey: null, turnTimerRemainingMs: null };
  }
  const key = clockIdentity(state);
  const actorKey = JSON.stringify([state.turnNumber, state.turnSequence ?? 0, requiredActor(state)]);
  if (state.paused) {
    return { ...state, turnDeadlineKey: key, turnTimerActorKey: actorKey, turnDeadlineAt: null,
      turnTimerRemainingMs: state.turnTimerActorKey !== actorKey ? seconds * 1000 :
        state.turnDeadlineAt != null ? Math.max(0, state.turnDeadlineAt - now) :
        state.turnTimerRemainingMs ?? seconds * 1000 };
  }
  const deadline = state.turnTimerActorKey === actorKey && state.turnDeadlineAt != null
    ? state.turnDeadlineAt : now + (state.turnTimerRemainingMs ?? seconds * 1000);
  return { ...state, turnDeadlineKey: key, turnTimerActorKey: actorKey, turnDeadlineAt: deadline, turnTimerRemainingMs: null };
}

export function expiredClock(state: GameState, now: number): boolean {
  return !!state.turnTimerSeconds && !state.paused && state.phase !== "waiting" &&
    state.phase !== "game_over" && state.turnDeadlineAt != null && state.turnDeadlineAt <= now;
}

export function expireTurnClock(state: GameState, expectedKey: string, expectedDeadline: number, now = Date.now()): GameState {
  if (!expiredClock(state, now) || state.turnDeadlineKey !== expectedKey || state.turnDeadlineAt !== expectedDeadline ||
      clockIdentity(state) !== expectedKey) return state;
  const actor = state.players.find(p => p.id === requiredActor(state));
  if (!actor) return state;
  let next = state;
  if (next.pendingDecision) {
    const result = resolveDecision(next, actor.id, buildAutoResolveData(next.pendingDecision));
    if (result.error) throw new Error(`Timed decision could not resolve: ${result.error}`);
    next = result.state;
  } else {
    if (next.phase === "draw") {
      const drawn = drawCardAction(next, actor.id);
      if (drawn.error) throw new Error(drawn.error);
      next = drawn.state;
    }
    const ended = endTurn(next, actor.id);
    if (ended.error) throw new Error(ended.error);
    next = ended.state;
    // Hand-limit decisions are part of finishing this same timed-out turn.
    for (let i = 0; next.pendingDecision?.type === "choose_discard_to_limit" && i < 8; i++) {
      const resolved = resolveDecision(next, actor.id, buildAutoResolveData(next.pendingDecision));
      if (resolved.error) throw new Error(resolved.error);
      next = resolved.state;
    }
  }
  next = recordMissedTurn(next, actor.id);
  next = runBotTurnsIfNeeded(next);
  next = { ...next, turnDeadlineAt: null, turnDeadlineKey: null, turnTimerRemainingMs: null,
    lastMeaningfulActivityAt: now,
    log: [...next.log, `Time ran out. ${actor.name}'s turn was finished automatically.`] };
  next = addSystemUpdate(next, `Time ran out. ${actor.name}'s turn was finished automatically.`, now);
  return syncTurnClock(next, now);
}