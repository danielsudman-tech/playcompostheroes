import assert from "node:assert/strict";
import { addUpdate, isHighlighted, noticeUpdate, scopeKey, updateFromEffect, GAME_UPDATES_CAP } from "./gameUpdates";

let list = [] as ReturnType<typeof noticeUpdate>[];
for (let i = 0; i < 60; i++) list = addUpdate(list, noticeUpdate(`n${i}`, `t${i}`, i));
assert.equal(list.length, GAME_UPDATES_CAP);
assert.equal(list[0].id, "n59");
assert.equal(addUpdate(list, noticeUpdate("n59", "dup", 1)), list);

const effect = { id: "e1", cardId: "c", cardName: "Heat Wave", cardText: "", imageKey: null,
  playedById: "a", playedByName: "Ana", outcome: [],
  events: [{ kind: "draw" as const, playerIds: ["b"], text: "Bo gained 2 cards" }] };
const u = updateFromEffect(effect, "b", 0);
assert.equal(u.personal, true);
assert.match(u.detail!, /Bo gained 2 cards/); // Legacy text is displayed without regex inference.
assert.equal(u.title, "Ana played Heat Wave");
assert.deepEqual(updateFromEffect({ ...effect, events: [1,2,3,4].map((n) => ({ kind: "info" as const, text: `e${n}` })), privateEvents: ["p"] }, "z", 0).lines, ["e1","e2","e3","e4","p"]);
assert.equal(updateFromEffect(effect, "z", 0).personal, false);
assert.equal(isHighlighted(u, 9_999), true);
assert.equal(isHighlighted(u, 10_001), false);
assert.equal(isHighlighted({ ...u, personal: false }, 5_001), false);
assert.notEqual(scopeKey({ gameId: "g", seatId: "a" }), scopeKey({ gameId: "g", seatId: "b" }));
console.log("gameUpdates ok");
