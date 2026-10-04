import assert from "node:assert/strict";
import {
  COMPOST_FUNCTION_ORDER, cardFunctions, compareCompostFunctions, decisionOriginCardName, decisionTitle, showStepBanner,
  HOME_WIN_COPY, ONGOING_HERO_COPY, ONGOING_ACTION_COPY, QUICK_RULES,
} from "./compostFunctions";

assert.deepEqual([...COMPOST_FUNCTION_ORDER], ["Moisture", "Carbon", "Decomposer", "Nitrogen", "Airflow"]);
assert.deepEqual(["Airflow", "Nitrogen", "Moisture"].sort(compareCompostFunctions), ["Moisture", "Nitrogen", "Airflow"]);
assert.deepEqual(cardFunctions({ function: "Airflow", alternateFunctions: ["Nitrogen", "Airflow", "Carbon"] }), ["Carbon", "Nitrogen", "Airflow"]);
assert.deepEqual(cardFunctions({ function: "Carbon" }), ["Carbon"]);
assert.deepEqual(cardFunctions({ function: "Carbon", alternateFunctions: [] }), ["Carbon"]);
assert.deepEqual(cardFunctions({ function: "Moisture", alternateFunctions: ["Carbon"] }), ["Moisture", "Carbon"]);
assert.equal(HOME_WIN_COPY, "Collect 1 Hero for each of the 5 compost functions to win!");
assert.equal(ONGOING_HERO_COPY, "This hero stays in your compost pile. Its effect lasts as long as it stays there.");
assert.equal(ONGOING_ACTION_COPY, "This card stays in play for everyone until another Ongoing card replaces it or a card removes it.");
assert.equal(decisionTitle("choose_function", "Sir Stink-No-More"), "Choose a function slot for Sir Stink-No-More");
assert.equal(decisionTitle("choose_card_from_hand", null, "Pick a card from your hand"), "Pick a card from your hand");
assert.equal(decisionTitle("choose_card_from_hand", "The Brown Bomber", "Pick a card from your hand"), "Pick a card from your hand for The Brown Bomber");
const heldName = decisionOriginCardName({ cardId: "sir", meta: { pendingCard: { id: "sir", name: "Sir Stink-No-More" } } }, []);
assert.equal(heldName, "Sir Stink-No-More", "the Hero is no longer in the hand while its slot is being chosen");
assert.equal(decisionTitle("choose_function", heldName), "Choose a function slot for Sir Stink-No-More");
assert.equal(decisionOriginCardName({ cardId: "different", meta: { pendingCard: { id: "sir", name: "Sir Stink-No-More" } } }, []), null);
assert.ok(!decisionTitle("x", null).includes("Action Required"));
assert.equal(showStepBanner({ total: 1 }), false);
assert.equal(showStepBanner({ total: 3 }), true);
assert.equal(showStepBanner(null), false);
for (const r of QUICK_RULES) assert.ok(!/layer|categor/i.test(r.lead + r.text));
assert.ok(QUICK_RULES.some(r => r.text.includes("draw 1 card") && r.text.includes("1 Hero, then up to 1 Action")));
console.log("compostFunctions tests passed");
