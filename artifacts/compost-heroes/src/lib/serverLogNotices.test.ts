import assert from "node:assert/strict";
import { canonicalLogNotices } from "./serverLogNotices";
import { addUpdate, noticeUpdate } from "./gameUpdates";
const t = "Time ran out. Sam's turn was finished automatically.";
const log = ["Sam drew a card", t, "Bo played Secret Hero", t, "Ana was removed from the game and permanently replaced by a bot."];
const n = canonicalLogNotices(log);
assert.equal(n.length, 3);
assert.notEqual(n[0].id, n[1].id);
assert.equal(canonicalLogNotices(["Sam drew a card", "private: you hold X"]).length, 0);
let list: ReturnType<typeof noticeUpdate>[] = [];
for (let pass = 0; pass < 3; pass++) for (const x of canonicalLogNotices(log)) list = addUpdate(list, noticeUpdate(x.id, x.text, pass));
assert.equal(list.length, 3); // repeated snapshots dedupe
import { systemNotices } from "./serverLogNotices";
const sys = [{ id: "s2", text: "B", ts: 2 }, { id: "s1", text: "A", ts: 1 }];
const viaSys = systemNotices(sys, log);
assert.deepEqual(viaSys.map((x) => x.id), ["system:s1", "system:s2"]); // no canonical duplicates
assert.equal(systemNotices([], log).length, 0); // new server, none yet: no fallback
assert.equal(systemNotices(undefined, log).length, 3); // old server falls back
console.log("serverLogNotices ok");
