import assert from "node:assert/strict";
import {
  EVENT_PRESENCE_SWEEP_INTERVAL_MS,
  EVENT_PRESENCE_SWEEP_OVERLAP_MS,
  EVENT_PRESENCE_TIMEOUT_MS,
  EventPresenceSweepCursor,
  isEventPresenceSweepCandidate,
  isEventSeatConnected,
  updateEventPresenceAndPublishTransition,
} from "../lib/eventPresence.js";

const now = 1_000_000;
assert.equal(EVENT_PRESENCE_TIMEOUT_MS, 45_000);
assert.equal(EVENT_PRESENCE_SWEEP_INTERVAL_MS, 10_000);
assert.equal(EVENT_PRESENCE_SWEEP_OVERLAP_MS, 1_000);
assert.equal(isEventSeatConnected(now - 45_000, now), true, "a seat remains connected through the 45-second boundary");
assert.equal(isEventSeatConnected(now - 45_001, now), false, "a seat disconnects after 45 seconds");
assert.equal(isEventSeatConnected(null, now), false);
assert.equal(isEventSeatConnected(new Date(now - 2_000), now), true);

assert.equal(isEventPresenceSweepCandidate(now - 45_000, now), false, "the sweep only selects a crossed threshold");
assert.equal(isEventPresenceSweepCandidate(now - 45_001, now), true);
assert.equal(isEventPresenceSweepCandidate(now - 120_000, now), true, "the first sweep recovers already-disconnected seats");
assert.equal(isEventPresenceSweepCandidate(null, now), false);

const cursor = new EventPresenceSweepCursor();
const previousSuccess = now - 10_000;
await cursor.run(async (previous) => {
  assert.equal(previous, null);
  return previousSuccess;
});
assert.equal(cursor.watermark, previousSuccess);

const driftedSweep = previousSuccess + 10_020;
const nearThresholdAtLastTick = previousSuccess - 44_990;
assert.equal(
  isEventPresenceSweepCandidate(nearThresholdAtLastTick, driftedSweep, previousSuccess),
  true,
  "a 44.99s-to-55.01s tick drift still falls inside the watermark-based query range",
);

await assert.rejects(cursor.run(async (previous) => {
  assert.equal(previous, previousSuccess);
  throw new Error("simulated failed sweep");
}));
assert.equal(cursor.watermark, previousSuccess, "a failed sweep does not advance the cutoff");
assert.equal(
  isEventPresenceSweepCandidate(nearThresholdAtLastTick, driftedSweep, cursor.watermark),
  true,
  "the missed interval remains eligible after a failed sweep",
);

const recoveredSweep = previousSuccess + 20_030;
await cursor.run(async (previous) => {
  assert.equal(previous, previousSuccess);
  return recoveredSweep;
});
assert.equal(cursor.watermark, recoveredSweep, "the cutoff advances after a successful retry");
assert.equal(
  isEventPresenceSweepCandidate(nearThresholdAtLastTick, recoveredSweep + EVENT_PRESENCE_SWEEP_INTERVAL_MS, cursor.watermark),
  false,
  "a successfully published disconnect is not selected again on later sweeps",
);

let heartbeatWrites = 0;
let publishedTransitions = 0;
const write = (lastSeenAt: number | null) => async () => {
  heartbeatWrites++;
  return lastSeenAt;
};
const publish = async () => { publishedTransitions++; };

assert.equal(
  await updateEventPresenceAndPublishTransition(write(now - 1_000), publish, now),
  false,
  "routine heartbeat does not publish",
);
assert.equal(heartbeatWrites, 1, "routine heartbeat performs one lightweight timestamp write");
assert.equal(publishedTransitions, 0, "routine heartbeat avoids detail rebuild/push");

assert.equal(
  await updateEventPresenceAndPublishTransition(write(now - 50_000), publish, now),
  true,
  "a stale seat publishes its recovery transition",
);
assert.equal(
  await updateEventPresenceAndPublishTransition(write(null), publish, now),
  true,
  "a newly seen or moved seat publishes its recovery transition",
);
assert.equal(
  await updateEventPresenceAndPublishTransition(async () => undefined, publish, now),
  false,
  "a seat removed after authentication does not publish a phantom transition",
);
assert.equal(publishedTransitions, 2);
