import assert from "node:assert/strict";
import { createGameState, playCard } from "../lib/gameEngine.js";
import { serializeState } from "../routes/game.js";

const maliciousName = "Same Name from compost gave swap from discard";
const state = createGameState("recap-privacy-test", [maliciousName, maliciousName], "facilitated");
const hiddenName = "Legacy Secret from compost";
state.players[0].hand[0] = { ...state.players[0].hand[0], name: hiddenName };
state.deck[0] = { ...state.deck[0], name: "Legacy Custom Card" };
state.log = [
  "Critter Raid! All players must discard 1 Nitrogen card from hand.",
  `${maliciousName} discarded ${hiddenName}.`,
  `${maliciousName} discarded Biochar from hand.`,
  `${maliciousName} gave ${hiddenName} to ${maliciousName}.`,
  `Same Name gave Worm Party to ${hiddenName}.`,
  `Worm Party — cards passed: ${maliciousName} → ${hiddenName}, Same Name → Biochar.`,
  `${maliciousName} discarded Fresh-Air Friend (Nitrogen) to draw 2 cards.`,
  `${maliciousName} exchanged Legacy Custom Card during a hand swap.`,
  `${maliciousName} discarded Captain Nectar, Biochar, Worm Party to meet hand limit.`,
  `${maliciousName} hand exceeded limit — auto-discarded Captain Nectar.`,
  `${maliciousName} discarded Captain Nectar, Biochar, Worm Party for Rot & Regrow.`,
  `${maliciousName} swapped ${hiddenName} from hand with The Breezy Bandit from discard (The Under-Web).`,
  `${maliciousName} played Worm Party.`,
  `${maliciousName} played The Breezy Bandit into their compost pile.`,
  `The Breezy Bandit ongoing effect is now active for ${maliciousName}.`,
  `${maliciousName} discarded The Soggy Saver from compost.`,
  `${maliciousName} placed Captain Nectar from discard into compost (Actinomycetes).`,
  `${maliciousName} took Biochar from discard pile into hand.`,
  `${maliciousName} took The Soggy Saver from Same Name's compost into hand.`,
];

const viewerLogs = [
  serializeState(state, 0).log,
  serializeState(state, 1).log,
  serializeState(state).log,
];
assert.deepEqual(viewerLogs[0], viewerLogs[1], "duplicate/malicious names must not imply recap ownership");
assert.deepEqual(viewerLogs[0], viewerLogs[2], "spectators receive the same safe raw recap");

for (const logs of viewerLogs) {
  for (const secret of [hiddenName, "Biochar from hand", "Captain Nectar, Biochar, Worm Party", "Fresh-Air Friend (Nitrogen)", "Legacy Custom Card", "The Breezy Bandit from discard"]) {
    assert.ok(!logs.some((line) => line.includes(secret)), `raw hidden identity/fragments must not appear: ${secret}`);
  }
}

const recap = viewerLogs[0];
assert.equal(recap[0], "Critter Raid! All players must discard 1 Nitrogen card from hand.");
assert.equal(recap[1], "A player discarded a card.", "the real bare Critter Raid format ignores malicious player-name phrases");
assert.equal(recap[2], "A player discarded a card from hand.");
assert.equal(recap[3], "A hidden-hand card was transferred.", "neither sender nor recipient fragments are trusted");
assert.equal(recap[4], "A hidden-hand card was transferred.");
assert.equal(recap[5], "Worm Party — passed-card details are hidden.");
assert.equal(recap[6], "A player discarded a Nitrogen card from hand.");
assert.equal(recap[7], "Hidden-hand card details withheld.");
assert.equal(recap[8], "A player discarded cards to meet the hand limit.");
assert.equal(recap[9], "A hand-limit discard occurred.");
assert.equal(recap[10], "A player discarded cards for Rot & Regrow.");
assert.equal(recap[11], "A hidden-hand exchange occurred; card details are hidden.");

assert.equal(recap[12], "A player publicly played Worm Party.", "publicly played card remains visible without trusting player labels");
assert.equal(recap[13], "A player publicly played The Breezy Bandit.");
assert.equal(recap[14], "A public ongoing effect is active: The Breezy Bandit.");
assert.equal(recap[15], "A public compost card was discarded: The Soggy Saver.", "validated public compost outcome remains visible");
assert.equal(recap[16], "A public discard-pile card entered compost: Captain Nectar.");
assert.equal(recap[17], "A public discard-pile card was taken: Biochar.");
assert.equal(recap[18], "A public compost card was taken into hand: The Soggy Saver.");

// Exercise the engine's real legacy Critter Raid line with a player name that
// contains the old substring bypass ("from compost").
let raidState = createGameState("recap-privacy-real-raid", [maliciousName, maliciousName], "facilitated");
// createGameState shuffles and deals before returning, so locate source cards
// across all zones instead of assuming either card remains in the deck.
const initialCards = [
  ...raidState.deck,
  ...raidState.players.flatMap((player) => [...player.hand, ...player.compostPile]),
  ...raidState.discardPile,
];
const raidCard = initialCards.find((card) => card.name === "Critter Raid");
const nitrogenSourceCard = initialCards.find((card) => card.function === "Nitrogen");
assert.ok(raidCard && nitrogenSourceCard, "Critter Raid and Nitrogen cards are present");
const nitrogenCard = { ...nitrogenSourceCard, name: hiddenName };
raidState = {
  ...raidState,
  phase: "play",
  // Reassemble the known source cards into a deterministic fixture while
  // preserving unique instance IDs and avoiding duplicate cards across zones.
  deck: initialCards.filter((card) => card.id !== raidCard.id && card.id !== nitrogenCard.id),
  discardPile: [],
  players: raidState.players.map((player, index) => ({
    ...player,
    compostPile: [],
    hand: index === 0 ? [raidCard] : [nitrogenCard],
  })),
};
const raidResult = playCard(raidState, raidState.players[0].id, raidCard.id);
assert.equal(raidResult.error, undefined, `Critter Raid failed: ${raidResult.error}`);
const rawCritterDiscard = raidResult.state.log.some((line) =>
  line === `${maliciousName} discarded ${hiddenName}.`
);
assert.ok(rawCritterDiscard, "the engine generated the expected private-card-bearing legacy line");
for (const viewerIndex of [0, 1, undefined]) {
  const serializedLog = serializeState(raidResult.state, viewerIndex).log;
  assert.ok(
    !serializedLog.some((line) => line.includes(hiddenName)),
    `real Critter Raid identity must be absent for viewer ${viewerIndex ?? "spectator"}`,
  );
}

console.log("recap-privacy.test.ts: all assertions passed ✔");