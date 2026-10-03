import assert from "node:assert/strict";
import { emptyBotQueue, ingestBotUpdates, releaseDue, nextWakeMs, turnCueDelay, type BotTurnUpdate } from "./botUpdateQueue";
const u = (id: string, ts: number): BotTurnUpdate => ({ id, playerId: "b", playerName: "Bot", summary: id, ts });

let s = emptyBotQueue();
let r = ingestBotUpdates(s, [u("old", 1)]);
assert.equal(r.immediate.length, 1); // baseline, not queued
s = r.state;
assert.equal(s.queue.length, 0);
r = ingestBotUpdates(s, [u("old", 1), u("b", 3), u("a", 2)]);
s = r.state;
assert.deepEqual(s.queue.map((x) => x.id), ["a", "b"]); // chronological
assert.equal(ingestBotUpdates(s, [u("a", 2), u("b", 3)]).state, s); // repeat is a no-op (SSE + POST)
assert.equal(turnCueDelay(s, 0), null);
let rel = releaseDue(s, 1000);
assert.equal(rel.released?.id, "a");
s = rel.state;
assert.equal(releaseDue(s, 1500).released, null); // gap not elapsed
assert.equal(nextWakeMs(s, 1500), 1000);
rel = releaseDue(s, 2500);
assert.equal(rel.released?.id, "b");
s = rel.state;
assert.equal(turnCueDelay(s, 2500), 1500);
assert.equal(turnCueDelay(s, 4000), 0);
assert.equal(ingestBotUpdates(s, [u("a", 2), u("b", 3)]).state.queue.length, 0); // reconnect stable
// Server always sends [] first: primes before the first bots, which then stage.
let p0 = ingestBotUpdates(emptyBotQueue(), []).state;
assert.equal(p0.primed, true);
assert.equal(ingestBotUpdates(p0, [u("x", 1)]).state.queue.length, 1);
assert.equal(ingestBotUpdates(emptyBotQueue(), undefined).state.primed, false);
// Turn cue defers behind the same queue and never goes negative.
assert.equal(turnCueDelay(ingestBotUpdates(p0, [u("x", 1)]).state, 0), null);
console.log("botUpdateQueue ok");
