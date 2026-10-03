import assert from "node:assert/strict";
import { coverTransitions, missedTurnsCopy } from "./botCover";
const p = (c: boolean) => [{ id: "a", name: "Sam", botCovering: c, consecutiveMissedTurns: 2 }];
assert.deepEqual(coverTransitions({}, p(true)), []);
assert.equal(coverTransitions({ a: false }, p(true))[0].kind, "covering");
assert.equal(coverTransitions({ a: true }, p(false))[0].kind, "back");
assert.deepEqual(coverTransitions({ a: true }, p(true)), []);
assert.equal(missedTurnsCopy("Sam", 2), "Sam missed two turns.");
console.log("botCover ok");
