import assert from "node:assert/strict";
import { gameRouteGateForResponse, isMissingGameError } from "./gameRouteStatus.js";

assert.deepEqual(gameRouteGateForResponse(null), { required: true, removed: false },
  "network failures keep the existing account gate and are not reported as removed");
assert.deepEqual(gameRouteGateForResponse({ status: 403, ok: false }), { required: true, removed: false },
  "authorization failures are not treated as removed games");
assert.deepEqual(gameRouteGateForResponse({ status: 500, ok: false }), { required: true, removed: false });
assert.deepEqual(gameRouteGateForResponse({ status: 404, ok: false }), { required: false, removed: true },
  "a public metadata 404 renders a friendly missing-game route before the account gate");
assert.deepEqual(gameRouteGateForResponse({ status: 200, ok: true, mode: "facilitated" }),
  { required: false, removed: false }, "existing facilitated games remain available without an account");
assert.deepEqual(gameRouteGateForResponse({ status: 200, ok: true, mode: "online" }),
  { required: true, removed: false }, "existing online games retain their account gate");
assert.deepEqual(gameRouteGateForResponse({ status: 200, ok: true }),
  { required: true, removed: false }, "missing metadata does not accidentally ungate an existing game");

assert.equal(isMissingGameError(Object.assign(new Error("removed"), { status: 404 })), true,
  "a 404 overrides stale cached game data in the table page");
assert.equal(isMissingGameError(Object.assign(new Error("forbidden"), { status: 403 })), false);
assert.equal(isMissingGameError(new TypeError("network error")), false);