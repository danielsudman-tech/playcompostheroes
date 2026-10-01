import assert from "node:assert/strict";
import { countsForHotPile, getCardBaseId, isHotPileCard } from "./hotPile";

assert.equal(
  countsForHotPile({
    id: "native-decomposer__1",
    function: "Decomposer",
    chosenFunction: "Carbon",
    alternateFunctions: ["Carbon"],
  }),
  true,
  "a native Decomposer function counts even when the placed and alternate slots are Carbon",
);
assert.equal(
  countsForHotPile({
    id: "alternate-decomposer__2",
    function: "Carbon",
    chosenFunction: "Carbon",
    alternateFunctions: ["Carbon", "Decomposer"],
  }),
  true,
  "any alternate Decomposer function counts while the card occupies Carbon",
);
assert.equal(
  countsForHotPile({
    id: "chosen-decomposer__3",
    function: "Carbon",
    chosenFunction: "Decomposer",
    alternateFunctions: ["Carbon", "Decomposer"],
  }),
  true,
  "a chosen Decomposer slot counts",
);
assert.equal(
  countsForHotPile({
    id: "carbon-only__4",
    function: "Carbon",
    chosenFunction: "Carbon",
    alternateFunctions: ["Carbon"],
  }),
  false,
);
assert.equal(getCardBaseId({ id: "hot_pile_bonus__31" }), "hot_pile_bonus");
assert.equal(isHotPileCard({ id: "hot_pile_bonus__31" }), true);
assert.equal(isHotPileCard({ id: "hot_pile_bonus__31", baseId: "old_card" }), false);

console.log("hotPile.test.ts: all assertions passed");