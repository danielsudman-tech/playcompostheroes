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

/** Engine rejection must not keep an unattended decision alive indefinitely. */
function resolveTimedDecision(state: GameState): { state: GameState; cleared: boolean } {
  const decision = state.pendingDecision!;
  for (const choose of [() => buildAutoResolveData(decision), () => ({ skip: true })]) {
    try {
      const data = choose();
      const result = resolveDecision(state, decision.playerId, data);
      if (!result.error) return { state: result.state, cleared: false };
    } catch { /* Use the same clear-and-continue fallback as bots. */ }
  }
  return { state: { ...state, pendingDecision: null }, cleared: true };
}

function finishTimedTurn(state: GameState, playerId: string): GameState {
  let next = state;
  if (next.phase === "draw") {
    const drawn = drawCardAction(next, playerId);
    if (drawn.error) throw new Error(drawn.error);
    next = drawn.state;
  }
  const ended = endTurn(next, playerId);
  if (ended.error) throw new Error(ended.error);
  next = ended.state;
  // Each successful discard reduces the hand. An invalid legacy choice is
  // cleared before a fresh endTurn rebuilds valid hand-limit options.
  for (let i = 0; next.pendingDecision?.type === "choose_discard_to_limit" && i < 32; i++) {
    const resolved = resolveTimedDecision(next);
    next = resolved.state;
    if (resolved.cleared) {
      const retry = endTurn(next, playerId);
      if (retry.error) throw new Error(retry.error);
      next = retry.state;
    }
  }
  if (next.pendingDecision?.type === "choose_discard_to_limit") throw new Error("Timed hand-limit completion did not converge");
  return next;
}

export function expireTurnClock(state: GameState, expectedKey: string, expectedDeadline: number, now = Date.now()): GameState {
  if (!expiredClock(state, now) || state.turnDeadlineKey !== expectedKey || state.turnDeadlineAt !== expectedDeadline ||
      clockIdentity(state) !== expectedKey) return state;
  const actor = state.players.find(p => p.id === requiredActor(state));
  if (!actor) return state;
  const isOwnTurn = state.players[state.currentPlayerIndex]?.id === actor.id;
  let next = state;
  let cleared = false;
  if (next.pendingDecision) {
    const resolved = resolveTimedDecision(next);
    next = resolved.state;
    cleared = resolved.cleared;
    if (cleared && isOwnTurn && next.phase !== "game_over") next = finishTimedTurn(next, actor.id);
  } else {
    next = finishTimedTurn(next, actor.id);
  }
  const turnEnded = isOwnTurn && (next.turnNumber !== state.turnNumber ||
    next.turnSequence !== state.turnSequence || next.currentPlayerIndex !== state.currentPlayerIndex);
  if (turnEnded) next = recordMissedTurn(next, actor.id, state.turnNumber);
  next = runBotTurnsIfNeeded(next);
  const message = turnEnded ? `Time ran out. ${actor.name}'s turn was finished automatically.`
    : `Time ran out. ${actor.name}'s choice was ${cleared ? "skipped" : "made"} automatically.`;
  next = { ...next, turnDeadlineAt: null, turnDeadlineKey: null, turnTimerRemainingMs: null,
    lastMeaningfulActivityAt: now,
    log: [...next.log, message] };
  next = addSystemUpdate(next, message, now);
  return syncTurnClock(next, now);
}