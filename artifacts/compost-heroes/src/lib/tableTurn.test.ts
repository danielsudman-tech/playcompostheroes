import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { turnButtonView, handCardLabel, hiddenHandLabel, drawAndCloseDrawer } from "./tableTurn";

assert.deepEqual(turnButtonView({ isMyTurn: true, phase: "draw", pending: false }), { kind: "draw", label: "Draw a Card", disabled: false });
assert.equal(turnButtonView({ isMyTurn: true, phase: "draw", pending: true }).disabled, true);
assert.deepEqual(turnButtonView({ isMyTurn: true, phase: "play", pending: false }), { kind: "end", label: "End Turn", disabled: false });
assert.equal(turnButtonView({ isMyTurn: false, phase: "draw", pending: false }).kind, null);
assert.equal(turnButtonView({ isMyTurn: true, phase: "game_over", pending: false }).kind, null);

assert.equal(handCardLabel({ name: "Worm Bin", type: "hero" }), "Worm Bin, hero");
assert.equal(hiddenHandLabel(1), "1 hidden card");
assert.ok(!hiddenHandLabel(3).includes("Worm"));

let closed = 0;
let cb: (() => void) | undefined;
const mutate = (o: { onSuccess: () => void }) => { cb = o.onSuccess; };
assert.equal(drawAndCloseDrawer({ isMyTurn: true, hasPlayer: true, pending: false }, mutate, () => closed++), true);
assert.equal(closed, 0);
cb!();
assert.equal(closed, 1);
for (const g of [{ isMyTurn: false, hasPlayer: true, pending: false }, { isMyTurn: true, hasPlayer: false, pending: false }, { isMyTurn: true, hasPlayer: true, pending: true }]) {
  cb = undefined;
  assert.equal(drawAndCloseDrawer(g, mutate, () => closed++), false);
  assert.equal(cb, undefined);
}
const tableSource = readFileSync(new URL("../pages/FacilitatedGame.tsx", import.meta.url), "utf8");
assert.match(tableSource, /absolute inset-x-0 top-0 bottom-16 .*md:hidden/, "drawer backdrop leaves the bottom turn bar reachable");
assert.match(tableSource, /absolute top-0 bottom-16 right-0 .*md:static/, "drawer itself cannot cover the turn bar");
assert.ok(tableSource.includes("invisible translate-x-full pointer-events-none"), "closed drawer controls are not keyboard targets");
assert.ok(tableSource.includes('aria-label="Draw a card from the pile"'));
console.log("tableTurn tests passed");
