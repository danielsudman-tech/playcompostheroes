import assert from "node:assert/strict";
import { createGameState, drawCardAction, endTurn, playCard, type GameState } from "../lib/gameEngine.js";
import { getAllCards } from "../lib/cards.js";
import { syncTurnClock, expireTurnClock } from "../lib/turnClock.js";
import { createTurnTimerScheduler, MAX_TIMER_ATTEMPTS } from "../lib/turnTimerRuntime.js";
import { recordMissedTurn } from "../lib/playerCover.js";

const base = (): GameState => ({ ...createGameState("correct-timer", ["Sam", "Alex"], "online"), turnTimerSeconds: 30 });
function timeout(state: GameState) {
  const timed = syncTurnClock(state, Date.now());
  return expireTurnClock(timed, timed.turnDeadlineKey!, timed.turnDeadlineAt!, timed.turnDeadlineAt! + 1);
}
{
  let state = base();
  const hero = getAllCards().find(c => c.type === "hero" && c.alternateFunctions?.length)!;
  assert.ok(hero);
  state.players[0].hand = [hero];
  state = playCard({ ...state, phase: "play" }, "player_0", hero.id).state;
  assert.equal(state.pendingDecision?.type, "choose_function");
  state = timeout(state);
  assert.equal(state.pendingDecision, null);
  assert.equal(state.players[0].consecutiveMissedTurns ?? 0, 0, "own choice expiry is not a missed turn");
  state = timeout(state);
  assert.equal(state.players[0].consecutiveMissedTurns, 1);
  assert.equal(state.players[0].isBot, false, "one own turn cannot trigger cover");
  assert.equal(recordMissedTurn(state, "player_0", 1), state);
  state = endTurn(drawCardAction(state, "player_1").state, "player_1").state;
  state = timeout(state);
  assert.equal(state.players[0].consecutiveMissedTurns, 2);
  assert.equal(state.players[0].botCovering, true, "two separate own turns trigger cover");
}
{
  const state = base();
  state.pendingDecision = { type: "choose_target_player", playerId: "player_1", cardId: "test", prompt: "Choose", options: [{ playerId: "player_0" }] };
  const next = timeout(state);
  assert.equal(next.pendingDecision, null);
  assert.equal(next.currentPlayerIndex, 0);
  assert.ok(next.players.every(p => !p.consecutiveMissedTurns), "choices during someone else's turn never count");
}
for (const owner of ["player_0", "player_1"]) {
  const state = base();
  state.pendingDecision = { type: "choose_function", playerId: owner, cardId: "missing-card", prompt: "Legacy broken decision", options: [{ function: "invalid" }] };
  const next = timeout(state);
  assert.equal(next.pendingDecision, null, "rejected default and skip are safely cleared");
  assert.equal(next.currentPlayerIndex, owner === "player_0" ? 1 : 0);
  assert.equal(next.players[0].consecutiveMissedTurns ?? 0, owner === "player_0" ? 1 : 0);
  assert.equal(next.players[1].consecutiveMissedTurns ?? 0, 0);
}
{
  const state = base();
  state.pendingDecision = { type: "choose_nitrogen_boost_discard", playerId: "player_0", cardId: "test", prompt: "Optional choice", options: [{ cardId: "missing-card" }] };
  const next = timeout(state);
  assert.equal(next.pendingDecision, null, "valid skip fallback is accepted");
  assert.equal(next.currentPlayerIndex, 0);
  assert.equal(next.players[0].consecutiveMissedTurns ?? 0, 0);
}
{
  const state = base();
  state.extraTurn = true;
  const first = timeout(state);
  assert.equal(first.currentPlayerIndex, 0);
  assert.equal(first.turnNumber, state.turnNumber);
  const next = timeout(first);
  assert.equal(next.players[0].consecutiveMissedTurns, 1, "even an extra turn cannot count the same turnNumber twice");
}

let serial = 0, attempts = 0, reports = 0;
const jobs = new Map<number, () => void>();
let scheduler: ReturnType<typeof createTurnTimerScheduler>;
scheduler = createTurnTimerScheduler({
  schedule: ((cb: () => void) => {
    const id = ++serial;
    jobs.set(id, cb);
    return { id, unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout,
  cancel: ((timer: { id: number }) => { jobs.delete(timer.id); }) as unknown as typeof clearTimeout,
  async run(state) {
    attempts++;
    scheduler.arm(state); // A durable reload must not start a second in-flight timer.
    throw new Error("synthetic persistence failure");
  },
  report() { reports++; },
});
const timed = syncTurnClock(base(), Date.now());
scheduler.arm(timed);
for (let i = 0; i < MAX_TIMER_ATTEMPTS; i++) {
  assert.equal(jobs.size, 1);
  const [id, run] = [...jobs][0];
  jobs.delete(id);
  run();
  for (let tick = 0; tick < 5; tick++) await Promise.resolve();
}
assert.equal(attempts, MAX_TIMER_ATTEMPTS);
assert.equal(reports, MAX_TIMER_ATTEMPTS);
assert.equal(jobs.size, 0, "retry budget exhausted: no timer, lock attempts, or repeated logging");
const originalDeadline = timed.turnDeadlineAt;
scheduler.arm(timed);
assert.equal(jobs.size, 0, "reload of the same failed deadline cannot restart the retry loop");
assert.equal(timed.turnDeadlineAt, originalDeadline, "durable deadline remains available to lazy reads");
scheduler.arm({ ...timed, turnDeadlineAt: timed.turnDeadlineAt! + 30000 });
assert.equal(jobs.size, 1, "a genuinely new deadline has a fresh retry budget");
scheduler.disarm(timed.gameId);
console.log("timer-corrections: own-turn misses, decision fallback, same-turn dedupe and bounded retries passed");