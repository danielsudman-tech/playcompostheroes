import assert from "node:assert/strict";
import {
  eventReadinessQueryKey,
  eventTablePath,
  isEventSeatReadyFromServer,
} from "./event-readiness.js";

assert.equal(isEventSeatReadyFromServer(undefined), false, "unknown readiness is never inferred as ready");
assert.equal(isEventSeatReadyFromServer({ ready: false }), false, "the server's not-ready value is authoritative");
assert.equal(isEventSeatReadyFromServer({ ready: true }), true, "the server's ready value is authoritative");

const seat = { gameId: "table / 1", playerId: "seat-1" };
assert.equal(eventTablePath(seat.gameId), "/game/table%20%2F%201/table");
const firstCredential = "secret-seat-token-one";
const secondCredential = "secret-seat-token-two";
const firstKey = eventReadinessQueryKey("AbC", seat, firstCredential);
const secondKey = eventReadinessQueryKey("AbC", seat, secondCredential);
assert.notDeepEqual(firstKey, secondKey, "readiness cache scope changes when the credential changes");
assert.ok(!JSON.stringify(firstKey).includes(firstCredential), "raw credentials are never placed in cache keys");
assert.ok(!JSON.stringify(secondKey).includes(secondCredential), "raw credentials are never placed in cache keys");

console.log("event-readiness.test.ts: all assertions passed ✔");