import assert from "node:assert/strict";
import { createGameState } from "../lib/gameEngine.js";
import {
  buildEffectAnnouncement,
  serializeEffectAnnouncement,
} from "../lib/facilitatedEffects.js";
import { getAllCards } from "../lib/cards.js";
import { serializeState } from "../routes/game.js";

function removeById<T extends { id: string }>(cards: T[], id: string): T[] {
  return cards.filter((card) => card.id !== id);
}

function baseId(card: { id: string; baseId?: string }): string {
  return card.baseId ?? card.id.split("__", 1)[0];
}

// A player can discard one card and draw two in the same effect. Net hand-size
// deltas lose the exact outcomes, so the public facts must track card instances.
{
  const initial = createGameState("effect-facts-delta", ["Sally", "Ben"], "facilitated");
  const actor = initial.players[0];
  const available = [...initial.deck, ...initial.players.flatMap((player) => player.hand)];
  const action = available.find((card) => baseId(card) === "fresh_air_friend");
  const discarded = available.find((card) => card.function === "Nitrogen");
  assert.ok(action);
  assert.ok(discarded);
  const drawn = initial.deck.filter((card) => card.id !== action.id && card.id !== discarded.id).slice(0, 2);
  assert.equal(drawn.length, 2);

  const before = {
    ...initial,
    phase: "play" as const,
    deck: removeById(removeById(initial.deck, action.id), discarded.id),
    players: initial.players.map((player, index) => index === 0
      ? { ...player, hand: [...removeById(removeById(player.hand, action.id), discarded.id), action, discarded] }
      : { ...player, hand: removeById(removeById(player.hand, action.id), discarded.id) }),
  };
  const after = {
    ...before,
    deck: before.deck.filter((card) => !drawn.some((next) => next.id === card.id)),
    discardPile: [discarded, action, ...before.discardPile],
    players: before.players.map((player, index) => index === 0
      ? {
          ...player,
          hand: [...removeById(removeById(player.hand, action.id), discarded.id), ...drawn],
        }
      : player),
  };
  const announcement = buildEffectAnnouncement(before, after, action, actor.id)!;
  const facts = announcement.events.map((event) => (event as any).fact);

  assert.ok(
    facts.some((fact) => fact?.kind === "hand_discard" && fact.count === 1 && fact.playerIds.includes(actor.id)),
    "the discarded hand card must be counted",
  );
  assert.ok(
    facts.some((fact) => fact?.kind === "draw" && fact.count === 2 && fact.playerIds.includes(actor.id)),
    "the two draws must be counted separately from the discard",
  );
  assert.equal(announcement.verb, "played");
  assert.deepEqual(announcement.players, before.players.map(({ id, name }) => ({ id, name })));

  const publicView = serializeEffectAnnouncement(announcement, "player_1")!;
  const ownerView = serializeEffectAnnouncement(announcement, actor.id)!;
  assert.ok(!JSON.stringify(publicView).includes(discarded.name), "public facts must not name a hidden hand card");
  assert.ok(
    ownerView.privateFacts?.some((fact: any) =>
      fact.kind === "hand_discard" && fact.cardName === discarded.name &&
      fact.function === (discarded.chosenFunction ?? discarded.function)),
    "only the owner receives the selected card's private name and function",
  );
  assert.deepEqual(publicView.privateFacts, []);
  assert.ok(!JSON.stringify(publicView).includes("privateFactsByPlayerId"));

  const storedState = { ...after, lastEffect: announcement };
  const ownerStateView = serializeState(storedState, 0).lastEffect!;
  const otherSeatStateView = serializeState(storedState, 1).lastEffect!;
  const spectatorStateView = serializeState(storedState).lastEffect!;
  assert.ok(ownerStateView.privateFacts?.some((fact) => fact.cardName === discarded.name));
  assert.deepEqual(otherSeatStateView.privateFacts, []);
  assert.deepEqual(spectatorStateView.privateFacts, []);
  assert.ok(!JSON.stringify(otherSeatStateView).includes(discarded.name));
  assert.ok(!JSON.stringify(spectatorStateView).includes(discarded.name));
}

// Public compost-card identities and their placed function can be named to the
// whole table, and the generated prose must not infer identity from raw text.
{
  const initial = createGameState("effect-facts-pile", ["Sally", "Ben"], "facilitated");
  const majorBrown = [...initial.deck, ...initial.players.flatMap((player) => player.hand)]
    .find((card) => baseId(card) === "major_brown");
  assert.ok(majorBrown);
  const before = {
    ...initial,
    deck: removeById(initial.deck, majorBrown.id),
    players: initial.players.map((player, index) => index === 0
      ? { ...player, hand: removeById(player.hand, majorBrown.id), compostPile: [majorBrown] }
      : { ...player, hand: removeById(player.hand, majorBrown.id) }),
  };
  const after = {
    ...before,
    discardPile: [majorBrown, ...before.discardPile],
    players: before.players.map((player, index) => index === 0
      ? { ...player, compostPile: [] }
      : player),
  };
  const announcement = buildEffectAnnouncement(before, after, null, "player_1")!;
  const fact = announcement.events.map((event) => (event as any).fact)
    .find((candidate) => candidate?.kind === "pile_loss");
  assert.equal(fact?.playerIds[0], "player_0");
  assert.equal(fact?.cardName, majorBrown.name);
  assert.equal(fact?.function, majorBrown.chosenFunction ?? majorBrown.function);
}

// Legion removes the ongoing instance; replacement produces only the new
// ongoing-card fact, not a misleading "old card removed" fact.
{
  const initial = createGameState("effect-facts-ongoing", ["Sally", "Ben"], "facilitated");
  const oldOngoing = { ...getAllCards().find((card) => card.id === "hot_pile_bonus")!, id: "hot_pile_bonus__31" };
  const replacement = { ...getAllCards().find((card) => card.id === "dry_spell")!, id: "dry_spell__47" };
  const before = {
    ...initial,
    ongoingActionCard: oldOngoing,
    activeModifiers: [{
      cardId: oldOngoing.baseId ?? "hot_pile_bonus",
      cardName: oldOngoing.name,
      effect: oldOngoing.cardText,
      appliedByPlayerId: "player_0",
    }],
  };
  const removed = buildEffectAnnouncement(
    before,
    { ...before, ongoingActionCard: null, activeModifiers: [] },
    before.players[0].hand[0],
    "player_1",
  )!;
  const removedFact = removed.events.map((event) => (event as any).fact)
    .find((candidate) => candidate?.kind === "ongoing_removed");
  assert.equal(removedFact?.cardName, oldOngoing.name);

  const replaced = buildEffectAnnouncement(
    before,
    { ...before, ongoingActionCard: replacement },
    before.players[0].hand[0],
    "player_1",
  )!;
  const ongoingFacts = replaced.events
    .map((event) => (event as any).fact)
    .filter((fact) => fact?.kind === "ongoing_set" || fact?.kind === "ongoing_removed");
  assert.deepEqual(ongoingFacts.map((fact) => fact.kind), ["ongoing_set"]);
  assert.equal(ongoingFacts[0].cardName, replacement.name);
}
