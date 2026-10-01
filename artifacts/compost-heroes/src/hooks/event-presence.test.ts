import assert from "node:assert/strict";
import {
  createEventPresenceScheduler,
  EVENT_PRESENCE_HEARTBEAT_INTERVAL_MS,
  EVENT_PRESENCE_HEARTBEAT_JITTER_MS,
  eventPresenceHeartbeatDelay,
} from "./event-presence";

assert.equal(eventPresenceHeartbeatDelay(() => 0), 12_000);
assert.equal(eventPresenceHeartbeatDelay(() => 0.5), EVENT_PRESENCE_HEARTBEAT_INTERVAL_MS);
assert.equal(eventPresenceHeartbeatDelay(() => 1), 18_000);
assert.equal(EVENT_PRESENCE_HEARTBEAT_INTERVAL_MS - EVENT_PRESENCE_HEARTBEAT_JITTER_MS, 12_000);

let now = 0;
let nextTimerId = 0;
let scheduledDelay = 0;
let timerCallback: (() => void) | null = null;
let requestCount = 0;
let finishRequest: (() => void) | undefined;
const scheduler = createEventPresenceScheduler({
  send: () => {
    requestCount++;
    return new Promise<void>((resolve) => { finishRequest = resolve; });
  },
  isVisible: () => true,
  schedule: (callback, delay) => {
    nextTimerId++;
    scheduledDelay = delay;
    timerCallback = callback;
    return nextTimerId as unknown as ReturnType<typeof window.setTimeout>;
  },
  cancel: () => { timerCallback = null; },
  random: () => 0.5,
  now: () => now,
});

assert.equal(requestCount, 1, "scheduler sends an initial presence heartbeat");
scheduler.requestImmediate();
scheduler.requestImmediate();
assert.equal(requestCount, 1, "focus/online requests coalesce while a heartbeat is in flight");
finishRequest?.();
await Promise.resolve();
await Promise.resolve();
assert.equal(scheduledDelay, EVENT_PRESENCE_HEARTBEAT_INTERVAL_MS, "routine interval uses the jitter helper");
assert.ok(timerCallback);

now = 1_001;
scheduler.requestImmediate();
assert.equal(requestCount, 2, "the first eligible focus request sends immediately");
scheduler.requestImmediate();
assert.equal(requestCount, 2, "repeated focus requests share the in-flight request");
finishRequest?.();
await Promise.resolve();
await Promise.resolve();
assert.ok(timerCallback, "a completed heartbeat returns to the bounded periodic schedule");
scheduler.stop();
assert.equal(timerCallback, null, "cleanup cancels the outstanding presence timer");
