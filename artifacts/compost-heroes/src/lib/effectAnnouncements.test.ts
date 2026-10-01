import assert from "node:assert/strict";
import {
  getEffectAnnouncementHeading,
  getPresentedEffectEvents,
  getPresentedPrivateFacts,
} from "./effectAnnouncements.js";
import type { EffectAnnouncementData } from "./effectAnnouncements.js";

function makeEffect(overrides: Partial<EffectAnnouncementData> = {}): EffectAnnouncementData {
  return {
    id: "effect-1",
    cardId: "critter_raid",
    cardName: "Critter Raid",
    cardText: "",
    imageKey: null,
    playedById: "sally",
    playedByName: "Sally",
    players: [
      { id: "sally", name: "Sally" },
      { id: "ben", name: "Ben" },
      { id: "zoe", name: "Zoe" },
    ],
    outcome: [],
    events: [],
    ...overrides,
  };
}

// Headlines describe what happened, independent of whether the viewer was
// involved. They never characterize anyone as "affected."
{
  const effect = makeEffect();
  assert.equal(getEffectAnnouncementHeading(effect, "ben"), "Sally played Critter Raid");
  assert.equal(getEffectAnnouncementHeading(effect, "sally"), "You played Critter Raid");
  assert.equal(
    getEffectAnnouncementHeading(makeEffect({ verb: "activated", cardName: "Hot Pile Bonus" }), "ben"),
    "Sally activated Hot Pile Bonus",
  );
}

// Local outcomes come first, then other named players. Matching all-player
// draws become one sentence rather than three copies.
{
  const effect = makeEffect({
    events: [
      {
        kind: "discard",
        playerIds: ["ben"],
        text: "Ben gave up 1 card from hand",
        fact: { kind: "hand_discard", actorId: "sally", playerIds: ["ben"], count: 1 },
      },
      {
        kind: "draw",
        playerIds: ["sally"],
        text: "Sally gained 1 card",
        fact: { kind: "draw", actorId: "sally", playerIds: ["sally"], count: 1 },
      },
      {
        kind: "draw",
        playerIds: ["ben"],
        text: "Ben gained 1 card",
        fact: { kind: "draw", actorId: "sally", playerIds: ["ben"], count: 1 },
      },
    ],
  });
  const presented = getPresentedEffectEvents(effect, "ben");
  assert.deepEqual(presented.map((entry) => entry.text), [
    "You discard 1 card from hand.",
    "You draw 1 card.",
    "Sally draws 1 card.",
  ]);
  assert.deepEqual(
    getPresentedEffectEvents(effect, "nobody").map((entry) => entry.text),
    ["Ben discards 1 card from hand.", "Sally draws 1 card.", "Ben draws 1 card."],
  );
}

{
  const everyoneDraws = makeEffect({
    events: ["sally", "ben", "zoe"].map((playerId) => ({
      kind: "draw" as const,
      playerIds: [playerId],
      text: `${playerId} gained 1 card`,
      fact: { kind: "draw" as const, actorId: "sally", playerIds: [playerId], count: 1 },
    })),
  });
  assert.deepEqual(
    getPresentedEffectEvents(everyoneDraws, "ben").map((entry) => entry.text),
    ["Everyone draws 1 card."],
  );
}

{
  const effect = makeEffect({
    events: [
      {
        kind: "discard",
        playerIds: ["zoe"],
        text: "Zoe gave up 1 card from hand",
        fact: { kind: "hand_discard", actorId: "sally", playerIds: ["zoe"], count: 1 },
      },
      {
        kind: "discard",
        playerIds: ["ben"],
        text: "Ben lost Major Brown from compost",
        fact: {
          kind: "pile_loss",
          actorId: "sally",
          playerIds: ["ben"],
          count: 1,
          cardName: "Major Brown",
          function: "Carbon",
        },
      },
      {
        kind: "skip",
        playerIds: ["sally"],
        text: "Sally will skip their next turn",
        fact: { kind: "skip", actorId: "sally", playerIds: ["sally"], count: 1 },
      },
      {
        kind: "modifier",
        text: "Hot Pile Bonus was removed from play",
        fact: {
          kind: "ongoing_removed",
          actorId: "sally",
          playerIds: [],
          count: 1,
          cardName: "Hot Pile Bonus",
        },
      },
    ],
  });
  assert.deepEqual(
    getPresentedEffectEvents(effect, "ben").map((entry) => entry.text),
    [
      "You lose Major Brown (Carbon) from your compost pile.",
      "Zoe discards 1 card from hand.",
      "Sally skips a turn.",
      "Hot Pile Bonus was removed from play.",
    ],
  );
}

// Old saved announcements keep displaying their existing safe prose; no
// regular-expression inference is attempted on the old event string.
{
  const oldEffect = makeEffect({
    events: [{
      kind: "discard",
      playerIds: ["ben"],
      text: "Ben gave up 1 card from hand",
    }],
  });
  assert.equal(
    getPresentedEffectEvents(oldEffect, "ben")[0].text,
    "Ben gave up 1 card from hand",
  );
}

// A discarded hand card's function is useful to its owner, but must not enter
// public wording. The exact card name stays in the owner-scoped data only.
{
  const effect = makeEffect({
    events: [{
      kind: "discard",
      playerIds: ["ben"],
      text: "Ben gave up 1 card from hand",
      fact: { kind: "hand_discard", actorId: "sally", playerIds: ["ben"], count: 1 },
    }],
    privateFacts: [{
      kind: "hand_discard",
      actorId: "sally",
      playerIds: ["ben"],
      count: 1,
      cardName: "Private Biochar",
      function: "Nitrogen",
    }],
  });
  assert.deepEqual(getPresentedPrivateFacts(effect, "ben"), ["You discard 1 Nitrogen card from your hand."]);
  assert.deepEqual(getPresentedPrivateFacts(effect, "sally"), []);
  assert.deepEqual(
    getPresentedEffectEvents(effect, "ben").map((entry) => entry.text),
    ["You discard 1 Nitrogen card from your hand."],
  );
  assert.deepEqual(
    getPresentedEffectEvents(effect, "sally").map((entry) => entry.text),
    ["Ben discards 1 card from hand."],
  );
  assert.ok(!getPresentedPrivateFacts(effect, "ben").join(" ").includes("Private Biochar"));
}

// A local private discard removes only the local seat from the public batch.
// Matching private cards with the same function are grouped by count, while
// the surviving seats keep their shared public result.
{
  const effect = makeEffect({
    events: [
      {
        kind: "discard",
        playerIds: ["sally"],
        text: "Sally gave up 2 cards from hand",
        fact: { kind: "hand_discard", actorId: "sally", playerIds: ["sally"], count: 2 },
      },
      ...["ben", "zoe"].map((playerId) => ({
        kind: "discard" as const,
        playerIds: [playerId],
        text: `${playerId} gave up 1 card from hand`,
        fact: { kind: "hand_discard" as const, actorId: "sally", playerIds: [playerId], count: 1 },
      })),
    ],
    privateFacts: [
      {
        kind: "hand_discard",
        actorId: "sally",
        playerIds: ["sally"],
        count: 1,
        cardName: "Hidden Nitrogen One",
        function: "Nitrogen",
      },
      {
        kind: "hand_discard",
        actorId: "sally",
        playerIds: ["sally"],
        count: 1,
        cardName: "Hidden Nitrogen Two",
        function: "Nitrogen",
      },
    ],
  });
  assert.deepEqual(
    getPresentedEffectEvents(effect, "sally").map((entry) => entry.text),
    [
      "You discard 2 Nitrogen cards from your hand.",
      "Everyone else discards 1 card from hand.",
    ],
  );
  assert.deepEqual(getPresentedPrivateFacts(effect, "sally"), [
    "You discard 2 Nitrogen cards from your hand.",
  ]);
  assert.deepEqual(
    getPresentedEffectEvents(effect, "ben").map((entry) => entry.text),
    [
      "You discard 1 card from hand.",
      "Sally discards 2 cards from hand.",
      "Zoe discards 1 card from hand.",
    ],
  );
  assert.deepEqual(getPresentedPrivateFacts(effect, "ben"), []);
}
