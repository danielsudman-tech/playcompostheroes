import assert from "node:assert/strict";
import { shareInvite } from "./shareInvite";

const abort = () => Object.assign(new Error("x"), { name: "AbortError" });
(async () => {
  let copied = 0;
  const writeText = async () => { copied++; };
  assert.equal(await shareInvite("u", { share: async () => {}, writeText }), "shared");
  assert.equal(await shareInvite("u", { share: async () => { throw abort(); }, writeText }), "cancelled");
  assert.equal(copied, 0);
  assert.equal(await shareInvite("u", { share: async () => { throw new Error("n"); }, writeText }), "copied");
  assert.equal(await shareInvite("u", { writeText }), "copied");
  assert.equal(await shareInvite("u", { writeText: async () => { throw new Error("d"); } }), "failed");
  assert.equal(await shareInvite("u", {}), "failed");
  console.log("shareInvite tests passed");
})();
