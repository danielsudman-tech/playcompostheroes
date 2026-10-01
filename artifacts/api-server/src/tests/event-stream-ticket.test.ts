import assert from "node:assert/strict";
import {
  consumeEventStreamTicket, issueEventStreamTicket, revokeEventStreamTickets,
} from "../lib/eventStreamTickets.js";

const now = 100_000;
const accountToken = "account-session-secret";
const ticket = issueEventStreamTicket("event-1", accountToken, now);

assert.notEqual(ticket, accountToken);
assert.ok(ticket.length >= 40, "ticket has cryptographic-random entropy");
assert.deepEqual(consumeEventStreamTicket(ticket, "event-1", now + 1), { userToken: accountToken });
assert.equal(consumeEventStreamTicket(ticket, "event-1", now + 2), null, "ticket is single-use");

const expired = issueEventStreamTicket("event-2", accountToken, now);
assert.equal(consumeEventStreamTicket(expired, "event-2", now + 60_000), null, "ticket expires after one minute");

const wrongEvent = issueEventStreamTicket("event-3", accountToken, now);
assert.equal(consumeEventStreamTicket(wrongEvent, "event-4", now + 1), null);
assert.equal(consumeEventStreamTicket(wrongEvent, "event-3", now + 2), null, "mismatched use consumes the ticket");

const revoked = issueEventStreamTicket("event-to-delete", accountToken, now);
const retained = issueEventStreamTicket("event-to-keep", accountToken, now);
assert.equal(revokeEventStreamTickets("event-to-delete"), 1);
assert.equal(consumeEventStreamTicket(revoked, "event-to-delete", now + 1), null,
  "deleting an event revokes every outstanding stream ticket for it");
assert.deepEqual(consumeEventStreamTicket(retained, "event-to-keep", now + 1), { userToken: accountToken },
  "revoking one event leaves another event's tickets untouched");
console.log("event-stream-ticket.test.ts: all assertions passed ✔");