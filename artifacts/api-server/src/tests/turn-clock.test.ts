import assert from "node:assert/strict";
import { createGameState, drawCardAction, endTurn } from "../lib/gameEngine.js";
import { syncTurnClock, expireTurnClock, clockIdentity } from "../lib/turnClock.js";

function timed() {
  return syncTurnClock({ ...createGameState("clock-test", ["Sam", "Alex"], "online"), turnTimerSeconds: 30 }, 1000);
}
function expire(state = timed()) {
  return expireTurnClock(state, state.turnDeadlineKey!, state.turnDeadlineAt!, 31001);
}
for (const phase of ["draw", "play"] as const) {
  const state = { ...timed(), phase };
  const before = state.players[0].hand.length;
  const next = expire(state);
  assert.equal(next.currentPlayerIndex, 1);
  assert.equal(next.players[0].hand.length, before + (phase === "draw" ? 1 : 0));
  assert.ok(next.log.includes("Time ran out. Sam's turn was finished automatically."));
}
for (const owner of [0, 1]) {
  let state = timed();
  state.pendingDecision = { type: "choose_target_player", playerId: state.players[owner].id,
    cardId: "test-choice", options: [{ playerId: state.players[1 - owner].id }], prompt: "Choose" };
  state = syncTurnClock(state, 1000);
  const next = expire(state);
  assert.equal(next.pendingDecision, null);
  assert.notEqual(next.turnDeadlineKey, state.turnDeadlineKey);
}
{
  const state = timed();
  const paused = syncTurnClock({ ...state, paused: true }, 11000);
  assert.equal(paused.turnDeadlineAt, null);
  assert.equal(paused.turnTimerRemainingMs, 20000);
  const resumed = syncTurnClock({ ...paused, paused: false }, 91000);
  assert.equal(resumed.turnDeadlineAt, 111000);
  assert.equal(expireTurnClock(paused, state.turnDeadlineKey!, 31000, 99999), paused);
}
for (const phase of ["waiting", "game_over"] as const) assert.equal(syncTurnClock({ ...timed(), phase }, 1000).turnDeadlineAt, null);
assert.equal(syncTurnClock({ ...timed(), turnTimerSeconds: 0 }).turnDeadlineAt, null);
assert.equal(syncTurnClock({ ...timed(), mode: "standalone" }).turnDeadlineAt, null);
{
  const state = timed();
  const drawn = drawCardAction(state, state.players[0].id).state;
  assert.equal(syncTurnClock(drawn, 2000).turnDeadlineAt, state.turnDeadlineAt, "drawing doesn't grant extra time");
  const moved = syncTurnClock(endTurn(drawn, state.players[0].id).state, 2000);
  assert.equal(expireTurnClock(moved, state.turnDeadlineKey!, 31000, 31001), moved, "old timer cannot finish a changed turn");
  const first = expire(state);
  assert.equal(expireTurnClock(first, state.turnDeadlineKey!, 31000, 31001), first, "one expiry wins");
  const reloaded = JSON.parse(JSON.stringify(state));
  assert.equal(expire(reloaded).currentPlayerIndex, 1, "durable deadline expires after a restart");
  assert.equal(clockIdentity(state).length, 64, "identity is opaque, not serialized hidden decision options");
}
{
  const state = timed();
  state.players[0].hand = [...state.players[0].hand, ...state.players[0].hand.map(c => ({ ...c, id: `${c.id}-extra` }))];
  const next = expire(state);
  assert.equal(next.players[0].hand.length, 5);
  assert.equal(next.pendingDecision, null);
}
console.log("turn-clock.test.ts: timer phase, decision, pause, race, lazy restart and hand-limit checks passed");