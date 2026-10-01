import assert from "node:assert/strict";
import { getAllCards } from "../lib/cards.js";
import {
  activateOngoing,
  captureEngineOperations,
  createGameState,
  mergeEngineOperationTraces,
  resolveDecision,
  runBotTurnsIfNeeded,
  type EffectAnnouncement,
} from "../lib/gameEngine.js";
import {
  buildEffectAnnouncement,
  serializeEffectAnnouncement,
} from "../lib/facilitatedEffects.js";

function template(id: string) {
  const card = getAllCards().find((candidate) => candidate.id === id);
  assert.ok(card, `card template ${id} must exist`);
  return card!;
}

function emptiedState(gameId: string) {
  const state = createGameState(gameId, ["Sally", "Ben"], "facilitated");
  return {
    ...state,
    phase: "play" as const,
    currentPlayerIndex: 0,
    deck: [],
    discardPile: [],
    players: state.players.map((player) => ({ ...player, hand: [], compostPile: [] })),
    pendingDecision: null,
  };
}

// An empty-deck Hot Pile draw reshuffles a public card, but it is still a draw,
// not a selected card from the discard pile. Its identity must not enter facts.
{
  const hotPile = template("hot_pile_bonus");
  const drawnCard = template("major_brown");
  const decomposers = getAllCards().filter((card) => card.function === "Decomposer").slice(0, 2);
  assert.equal(decomposers.length, 2);
  const base = emptiedState("trace-hot-pile");
  const before = {
    ...base,
    discardPile: [drawnCard],
    ongoingActionCard: hotPile,
    players: base.players.map((player, index) => index === 0
      ? { ...player, compostPile: decomposers }
      : player),
  };
  const captured = captureEngineOperations(before, () => activateOngoing(before, "player_0"));
  assert.equal(captured.result.error, undefined);
  assert.deepEqual(captured.trace.draws, [{ playerId: "player_0", cardIds: [drawnCard.id] }]);

  const effect = buildEffectAnnouncement(
    before,
    captured.result.state,
    hotPile,
    "player_0",
    "activated",
    captured.trace,
  )!;
  const facts = effect.events.map((event) => event.fact);
  assert.ok(facts.some((fact) => fact?.kind === "draw" && fact.count === 1));
  assert.ok(!facts.some((fact) => fact?.kind === "discard_to_hand"));
  assert.ok(!effect.events.some((event) => event.fact?.cardName === drawnCard.name));
  assert.ok(!JSON.stringify(serializeEffectAnnouncement(effect, "player_1")).includes(drawnCard.name));
  assert.ok(!Object.keys(captured.result.state).some((key) => /trace|operation/i.test(key)));
  assert.ok(!JSON.stringify(captured.result.state).includes("drawnCardIds"));
}

// Bot-only announcements use the bot turn's actual draw trace. A card reshuffled
// into the bot's hand is not a named discard-pile selection when the bot plays
// an unrelated new Ongoing Action.
{
  const hotPile = template("hot_pile_bonus");
  const unrelatedDiscardCard = template("dry_spell");
  const decomposers = getAllCards().filter((card) => card.function === "Decomposer").slice(0, 2);
  const initial = createGameState("trace-bot-ongoing", ["Sally", "Bot"], "facilitated", [1], { 1: "medium" });
  const before = {
    ...initial,
    phase: "draw" as const,
    currentPlayerIndex: 1,
    deck: [],
    discardPile: [unrelatedDiscardCard],
    players: initial.players.map((player, index) => index === 1
      ? { ...player, hand: [hotPile], compostPile: decomposers }
      : { ...player, hand: [], compostPile: [] }),
  };
  const captured = captureEngineOperations(
    before,
    () => ({ state: runBotTurnsIfNeeded(before) }),
  );
  assert.equal(captured.result.state.ongoingActionCard?.id, hotPile.id);
  assert.deepEqual(captured.trace.draws, [{ playerId: "player_1", cardIds: [unrelatedDiscardCard.id] }]);
  const effect = buildEffectAnnouncement(
    before,
    captured.result.state,
    hotPile,
    "player_1",
    "played",
    captured.trace,
  )!;
  assert.ok(effect.events.some((event) => event.fact?.kind === "draw" && event.fact.count === 1));
  assert.ok(effect.events.some((event) => event.fact?.kind === "ongoing_set"));
  assert.ok(!effect.events.some((event) =>
    event.fact?.kind === "discard_to_hand" || event.fact?.cardName === unrelatedDiscardCard.name
  ));
  assert.ok(!JSON.stringify(serializeEffectAnnouncement(effect, "player_0")).includes(unrelatedDiscardCard.name));
}

// Nitrogen Boost discards one held card, then draws two after a full discard
// reshuffle. The exact instance may return to its owner's hand; the transient
// trace must preserve both operations without exposing the card to others.
{
  const nitrogenBoost = template("nitrogen_boost");
  const discardedNitrogen = getAllCards().find((card) => card.function === "Nitrogen")!;
  const otherDiscard = template("major_brown");
  const base = emptiedState("trace-nitrogen-boost");
  const before = {
    ...base,
    discardPile: [otherDiscard],
    ongoingActionCard: nitrogenBoost,
    pendingDecision: {
      type: "choose_nitrogen_boost_discard" as const,
      playerId: "player_0",
      cardId: nitrogenBoost.id,
      prompt: "Discard a Nitrogen card.",
      options: [],
      meta: { optional: true, originVerb: "activated" },
    },
    players: base.players.map((player, index) => index === 0
      ? { ...player, hand: [discardedNitrogen] }
      : player),
  };
  const captured = captureEngineOperations(
    before,
    () => resolveDecision(before, "player_0", { cardId: discardedNitrogen.id }),
  );
  assert.equal(captured.result.error, undefined);
  assert.equal(captured.trace.handDiscards.length, 1);
  assert.equal(captured.trace.handDiscards[0].card.id, discardedNitrogen.id);
  assert.equal(captured.trace.draws.reduce((sum, draw) => sum + draw.cardIds.length, 0), 2);
  assert.ok(captured.trace.draws.some((draw) => draw.cardIds.includes(discardedNitrogen.id)),
    "the discarded instance is returned by reshuffling the full discard pile");

  const effect = buildEffectAnnouncement(
    before,
    captured.result.state,
    nitrogenBoost,
    "player_0",
    "activated",
    captured.trace,
  )!;
  assert.equal(effect.verb, "activated");
  assert.ok(effect.events.some((event) => event.fact?.kind === "hand_discard" && event.fact.count === 1));
  assert.ok(effect.events.some((event) => event.fact?.kind === "draw" && event.fact.count === 2));
  assert.ok(!effect.events.some((event) => event.fact?.kind === "discard_to_hand"));
  assert.ok(!effect.events.some((event) =>
    event.fact?.cardName === discardedNitrogen.name || event.fact?.cardName === otherDiscard.name
  ));

  const owner = serializeEffectAnnouncement(effect, "player_0")!;
  const other = serializeEffectAnnouncement(effect, "player_1")!;
  assert.ok(owner.privateFacts?.some((fact) =>
    fact.kind === "hand_discard" && fact.cardName === discardedNitrogen.name &&
    fact.function === (discardedNitrogen.chosenFunction ?? discardedNitrogen.function)
  ));
  assert.ok(!JSON.stringify(other).includes(discardedNitrogen.name));
  assert.ok(!JSON.stringify(other).includes(otherDiscard.name));
  assert.ok(!JSON.stringify(owner).includes(discardedNitrogen.id));
  assert.ok(!JSON.stringify(other).includes(discardedNitrogen.id));
}

// The route combines a human decision trace with a subsequent bot-completion
// trace, so both actors' actual draws survive in the same before/after announcement.
{
  const nitrogenBoost = template("nitrogen_boost");
  const discardedNitrogen = getAllCards().find((card) => card.function === "Nitrogen")!;
  const humanDraws = [template("major_brown"), template("rainstorm")];
  const botDraw = template("dry_spell");
  const initial = createGameState("trace-human-and-bot", ["Sally", "Bot"], "facilitated", [1], { 1: "medium" });
  const before = {
    ...initial,
    phase: "play" as const,
    currentPlayerIndex: 0,
    deck: [...humanDraws, botDraw],
    discardPile: [],
    ongoingActionCard: nitrogenBoost,
    pendingDecision: {
      type: "choose_nitrogen_boost_discard" as const,
      playerId: "player_0",
      cardId: nitrogenBoost.id,
      prompt: "Discard a Nitrogen card.",
      options: [],
      meta: { optional: true, originVerb: "activated" },
    },
    players: initial.players.map((player, index) => index === 0
      ? { ...player, hand: [discardedNitrogen] }
      : { ...player, hand: [], compostPile: [] }),
  };
  const human = captureEngineOperations(
    before,
    () => resolveDecision(before, "player_0", { cardId: discardedNitrogen.id }),
  );
  assert.equal(human.result.error, undefined);

  // Model the bot-completion interval after the human decision has resolved.
  const botStart = {
    ...human.result.state,
    phase: "draw" as const,
    currentPlayerIndex: 1,
  };
  const bot = captureEngineOperations(
    botStart,
    () => ({ state: runBotTurnsIfNeeded(botStart) }),
  );
  const combinedTrace = mergeEngineOperationTraces(human.trace, bot.trace);
  const effect = buildEffectAnnouncement(
    before,
    bot.result.state,
    nitrogenBoost,
    "player_0",
    "activated",
    combinedTrace,
  )!;
  const drawFacts = effect.events.filter((event) => event.fact?.kind === "draw");
  assert.deepEqual(
    drawFacts.map((event) => ({ playerId: event.fact!.playerIds[0], count: event.fact!.count })),
    [{ playerId: "player_0", count: 2 }, { playerId: "player_1", count: 1 }],
  );
  assert.equal(drawFacts.reduce((sum, event) => sum + event.fact!.count, 0), 3);
}

// A deliberate choice from the discard pile remains a named public outcome.
{
  const biochar = template("biochar");
  const selectedCard = template("major_brown");
  const base = emptiedState("trace-explicit-discard-pick");
  const before = {
    ...base,
    discardPile: [selectedCard],
    pendingDecision: {
      type: "choose_card_from_discard" as const,
      playerId: "player_0",
      cardId: biochar.id,
      prompt: "Choose a card from discard.",
      options: [{ cardId: selectedCard.id, cardName: selectedCard.name }],
    },
  };
  const captured = captureEngineOperations(
    before,
    () => resolveDecision(before, "player_0", { cardId: selectedCard.id }),
  );
  assert.equal(captured.result.error, undefined);
  assert.deepEqual(captured.trace.discardToHand, [{ playerId: "player_0", card: selectedCard }]);

  const effect = buildEffectAnnouncement(
    before,
    captured.result.state,
    biochar,
    "player_0",
    "played",
    captured.trace,
  )!;
  const selectedFact = effect.events.find((event) => event.fact?.kind === "discard_to_hand")?.fact;
  assert.equal(effect.trustedExplicitDiscardToHand, true);
  assert.equal(selectedFact?.cardName, selectedCard.name);
  assert.equal(selectedFact?.playerIds[0], "player_0");
  const publicView = serializeEffectAnnouncement(effect, "player_1")!;
  const ownerView = serializeEffectAnnouncement(effect, "player_0")!;
  assert.equal(publicView.trustedExplicitDiscardToHand, undefined, "provenance marker stays server-only");
  assert.equal(
    publicView.events.find((event) => event.fact?.kind === "discard_to_hand")?.fact?.cardName,
    selectedCard.name,
    "a new, explicitly selected discard card remains publicly named",
  );
  assert.equal(
    ownerView.events.find((event) => event.fact?.kind === "discard_to_hand")?.fact?.cardName,
    selectedCard.name,
  );
}

// Legacy saved announcements have no trustworthy distinction between an
// explicit discard pick and a random reshuffle. Redact those names at the
// serialization boundary while retaining safe pile names and owner details.
{
  const secretlyHeld = template("major_brown");
  const ambiguouslyGained = template("rainstorm");
  const publicPileCard = getAllCards().find((card) => card.function === "Moisture")!;
  const legacy: EffectAnnouncement = {
    id: "legacy-ambiguous-discard-gain",
    cardId: "biochar",
    cardName: "Biochar",
    cardText: "Choose a card from discard.",
    imageKey: null,
    playedById: "player_0",
    playedByName: "Sally",
    outcome: [
      `Joe took ${ambiguouslyGained.name} from the discard pile.`,
      "Joe gave up 1 card from hand.",
    ],
    events: [
      {
        kind: "info",
        playerIds: ["player_1"],
        text: `Joe took ${ambiguouslyGained.name} from discard.`,
        fact: {
          kind: "discard_to_hand",
          actorId: "player_0",
          playerIds: ["player_1"],
          count: 1,
          cardName: ambiguouslyGained.name,
          function: ambiguouslyGained.function,
          targetPlayerId: "player_1",
        },
      },
      {
        kind: "discard",
        playerIds: ["player_1"],
        text: "Joe gave up 1 card from hand",
        fact: {
          kind: "hand_discard",
          actorId: "player_0",
          playerIds: ["player_1"],
          count: 1,
          cardName: secretlyHeld.name,
          function: secretlyHeld.function,
        },
      },
      {
        kind: "discard",
        playerIds: ["player_1"],
        text: `${publicPileCard.name} left Joe's pile → discard`,
        fact: {
          kind: "pile_loss",
          actorId: "player_0",
          playerIds: ["player_1"],
          count: 1,
          cardName: publicPileCard.name,
          function: publicPileCard.function,
        },
      },
    ],
    privateEventsByPlayerId: {
      player_1: [`${secretlyHeld.name} (${secretlyHeld.function}) was discarded from your hand`],
    },
    privateFactsByPlayerId: {
      player_1: [{
        kind: "hand_discard",
        actorId: "player_0",
        playerIds: ["player_1"],
        count: 1,
        cardName: secretlyHeld.name,
        function: secretlyHeld.function,
      }],
    },
  };

  const shared = serializeEffectAnnouncement(legacy, "player_0")!;
  const owner = serializeEffectAnnouncement(legacy, "player_1")!;
  const other = serializeEffectAnnouncement(legacy, "player_2")!;
  const ambiguousEvent = shared.events[0];
  assert.equal(ambiguousEvent.text, "A player gained cards.");
  assert.equal(ambiguousEvent.fact, undefined);
  assert.equal(ambiguousEvent.playerIds, undefined);
  assert.ok(!JSON.stringify(shared).includes(ambiguouslyGained.name));
  assert.ok(!JSON.stringify(shared).includes(ambiguouslyGained.function));
  assert.equal(shared.outcome[0], "A player gained cards.");
  assert.equal(shared.outcome[1], "Joe gave up 1 card from hand.", "safe legacy generic text remains readable");
  for (const view of [shared, owner, other]) {
    assert.ok(!JSON.stringify(view.events).includes(ambiguouslyGained.name));
    assert.ok(!JSON.stringify(view.outcome).includes(ambiguouslyGained.name));
  }
  const publicHandDiscard = shared.events[1].fact!;
  assert.equal(publicHandDiscard.cardName, undefined);
  assert.equal(publicHandDiscard.function, undefined);
  assert.ok(!JSON.stringify(owner.events).includes(secretlyHeld.name));
  assert.equal(shared.events[2].fact?.cardName, publicPileCard.name, "public compost names remain visible");
  assert.ok(owner.privateFacts?.some((fact) =>
    fact.kind === "hand_discard" &&
    fact.cardName === secretlyHeld.name &&
    fact.function === secretlyHeld.function
  ), "the affected hand owner keeps their private card detail");
  assert.ok(owner.privateEvents?.some((detail) => detail.includes(secretlyHeld.name)));
  assert.deepEqual(shared.privateFacts, []);
  assert.equal(shared.trustedExplicitDiscardToHand, undefined);
  assert.ok(!JSON.stringify(other).includes(secretlyHeld.name), "unaffected viewers get neither private maps nor hand names");
}

// State-diff-only callers still report an ambiguous discard-to-hand transition
// as a generic gain, never as a named discard-pile selection.
{
  const biochar = template("biochar");
  const ambiguousCard = template("major_brown");
  const base = emptiedState("trace-no-operations-fallback");
  const before = { ...base, discardPile: [ambiguousCard] };
  const after = {
    ...before,
    discardPile: [],
    players: before.players.map((player, index) => index === 0
      ? { ...player, hand: [ambiguousCard] }
      : player),
  };
  const effect = buildEffectAnnouncement(before, after, biochar, "player_0")!;
  assert.ok(!effect.events.some((event) => event.fact?.kind === "discard_to_hand"));
  assert.ok(!effect.events.some((event) => event.fact?.cardName === ambiguousCard.name));
  assert.ok(effect.events.some((event) => event.text === "Sally gained 1 card."));
}

// Activation context survives the Rot & Regrow decision chain, while a legacy
// saved decision with no origin metadata can still use the safe "played" default.
{
  const rotRegrow = template("rot_regrow");
  const base = emptiedState("trace-origin-verb");
  const cards = getAllCards().filter((card) => card.type === "hero").slice(0, 3);
  const before = {
    ...base,
    ongoingActionCard: rotRegrow,
    players: base.players.map((player, index) => index === 0
      ? { ...player, hand: cards }
      : player),
  };
  const activated = activateOngoing(before, "player_0");
  assert.equal(activated.state.pendingDecision?.meta?.originVerb, "activated");
  assert.equal(activated.state.pendingDecision?.meta?.originActorId, "player_0");
  const discarded = resolveDecision(activated.state, "player_0", { cardIds: cards.map((card) => card.id) });
  assert.equal(discarded.error, undefined);
  assert.equal(discarded.state.pendingDecision?.type, "choose_rot_regrow_take");
  assert.equal(discarded.state.pendingDecision?.meta?.originVerb, "activated");
  assert.equal(discarded.state.pendingDecision?.meta?.originActorId, "player_0");
}