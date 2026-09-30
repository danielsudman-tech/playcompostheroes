/**
 * Integration test for facilitated-mode effect announcements:
 *
 *  1. A multi-step decision chain keeps broadcasting the ORIGINATING card's
 *     identity (name/text) at every resolution step, even after the card has
 *     moved zones (e.g. into a compost pile).
 *  2. A function-slot move (move_card_layer) produces an announcement carrying
 *     the moved card's identity.
 *
 * Run with: pnpm --filter @workspace/api-server run test:effect-announcements
 */
import assert from "node:assert/strict";
import { createGameState, playCard, resolveDecision, moveCardLayer } from "../lib/gameEngine.js";
import { buildEffectAnnouncement, findEffectCard, serializeEffectAnnouncement } from "../lib/facilitatedEffects.js";
import { getCardValidFunctions } from "../lib/cards.js";

function liftIntoHand(state: ReturnType<typeof createGameState>, namePattern: RegExp) {
  const deckIdx = state.deck.findIndex((c) => namePattern.test(c.name));
  if (deckIdx >= 0) {
    const card = state.deck[deckIdx];
    const s = { ...state, deck: state.deck.filter((_, i) => i !== deckIdx), phase: "play" as const };
    s.players[0].hand.push(card);
    return { s, card };
  }
  for (const [pi, p] of state.players.entries()) {
    const hi = p.hand.findIndex((c) => namePattern.test(c.name));
    if (hi >= 0) {
      const card = p.hand[hi];
      const players = state.players.map((pl, i) =>
        i === pi && i !== 0 ? { ...pl, hand: pl.hand.filter((_, j) => j !== hi) } : pl
      );
      if (pi !== 0) players[0] = { ...players[0], hand: [...players[0].hand, card] };
      return { s: { ...state, players, phase: "play" as const }, card };
    }
  }
  return null;
}

// ── 1. Multi-step decision chain keeps the originating card's identity ───────
// Worm Party: after playing, the card leaves the actor's hand while decisions
// may still be pending — the announcement must still name Worm Party.
{
  const base = createGameState("fx-test-1", ["Maria", "Ben", "Zoe"], "facilitated");
  const lifted = liftIntoHand(base, /worm party/i);
  assert.ok(lifted, "Worm Party must exist in the game");
  const { s, card } = lifted!;

  const played = playCard(s, "player_0", card.id);
  assert.equal(played.error, undefined, played.error);
  let cur = played.state;
  let steps = 0;
  while (cur.pendingDecision && steps++ < 10) {
    const d = cur.pendingDecision;
    // The route resolves the originating card from pendingDecision.cardId across both states:
    const before = cur;
    const owner = cur.players.find((p) => p.id === d.playerId)!;
    const rr = resolveDecision(cur, d.playerId, {
      cardId: owner.hand[0]?.id,
      cardIds: [owner.hand[0]?.id],
    });
    assert.equal(rr.error, undefined, `resolve failed at step ${steps}: ${rr.error}`);
    const effectCard = findEffectCard(before, rr.state, d.cardId);
    assert.ok(effectCard, `originating card must be resolvable at step ${steps}`);
    const fx = buildEffectAnnouncement(before, rr.state, effectCard, d.playerId);
    assert.ok(fx, "announcement must be built");
    assert.match(fx!.cardName, /worm party/i, `announcement must carry the originating card, got "${fx!.cardName}"`);
    assert.ok(fx!.cardText.length > 0, "announcement must carry the card's effect text");
    cur = rr.state;
  }
  assert.ok(steps > 0, "Worm Party should have produced at least one decision step");
}

// ── 2. Function-slot move announces the moved card ───────────────────────────
{
  const base = createGameState("fx-test-2", ["Maria", "Ben"], "facilitated");
  // Find a multi-function hero anywhere and put it in Maria's compost pile.
  const allZones = [...base.deck, ...base.players.flatMap((p) => p.hand)];
  const multi = allZones.find((c) => c.type === "hero" && getCardValidFunctions(c).length > 1);
  assert.ok(multi, "a multi-function hero must exist");
  const s = {
    ...base,
    phase: "play" as const,
    deck: base.deck.filter((c) => c.id !== multi!.id),
    players: base.players.map((p, i) =>
      i === 0
        ? { ...p, hand: p.hand.filter((c) => c.id !== multi!.id), compostPile: [...p.compostPile, multi!] }
        : { ...p, hand: p.hand.filter((c) => c.id !== multi!.id) }
    ),
  };
  const currentFn = multi!.chosenFunction ?? multi!.function;
  const target = getCardValidFunctions(multi!).find((f) => f !== currentFn);
  const moved = moveCardLayer(s, "player_0", multi!.id, target);
  assert.equal(moved.error, undefined, `moveCardLayer failed: ${moved.error}`);
  const effectCard = findEffectCard(s, moved.state, multi!.id);
  assert.ok(effectCard, "moved card must be resolvable");
  const fx = buildEffectAnnouncement(s, moved.state, effectCard, "player_0");
  assert.ok(fx, "move announcement must be built");
  assert.equal(fx!.cardName, multi!.name, "announcement must carry the moved card's identity");
}

// ── 3. Playing an Action is a cost, not a personal discard consequence ────────
{
  const base = createGameState("fx-test-action-cost", ["Actor", "Victim"], "facilitated");
  const lifted = liftIntoHand(base, /fresh-air friend/i);
  assert.ok(lifted, "an Action card must exist for the actor");
  const { s, card } = lifted!;
  const before = { ...s, phase: "play" as const };
  const after = {
    ...before,
    discardPile: [...before.discardPile, card],
    players: before.players.map((player, index) =>
      index === 0 ? { ...player, hand: player.hand.filter((held) => held.id !== card.id) } : player
    ),
  };
  const fx = buildEffectAnnouncement(before, after, card, "player_0")!;
  assert.ok(!fx.events.some((event) => event.playerIds?.includes("player_0")), "playing the Action must not be classified as a self-impact");
  assert.equal(fx.outcome.length, 0, "raw game-log outcomes are excluded from shared announcements");
}

// ── 4. Victim hand discard is attributable, private, and exact only to victim ─
{
  const base = createGameState("fx-test-victim-discard", ["Actor", "Victim"], "facilitated");
  const lifted = liftIntoHand(base, /fresh-air friend/i);
  assert.ok(lifted);
  const { s, card: actionCard } = lifted!;
  const victimCard = s.players[1].hand[0];
  const before = { ...s, phase: "play" as const };
  const after = {
    ...before,
    discardPile: [...before.discardPile, actionCard, victimCard],
    players: before.players.map((player, index) => ({
      ...player,
      hand: player.hand.filter((held) => held.id !== (index === 0 ? actionCard.id : victimCard.id)),
    })),
  };
  const fx = buildEffectAnnouncement(before, after, actionCard, "player_0")!;
  assert.ok(!fx.events.some((event) => event.playerIds?.includes("player_0")), "actor's Action cost is not a victim impact");
  assert.ok(fx.events.some((event) => event.kind === "discard" && event.playerIds?.includes("player_1")), "victim discard must be identified publicly");
  assert.ok(fx.privateEventsByPlayerId?.player_1?.some((detail) => detail.includes(victimCard.name)), "victim receives the exact discarded card");
  assert.ok(fx.privateEventsByPlayerId?.player_1?.some((detail) =>
    detail.includes(victimCard.chosenFunction ?? victimCard.function)
  ), "victim receives the discarded card's function");

  const victimView = serializeEffectAnnouncement(fx, "player_1")!;
  const actorView = serializeEffectAnnouncement(fx, "player_0")!;
  const sharedView = serializeEffectAnnouncement(fx, undefined)!;
  assert.ok(victimView.privateEvents?.some((detail) => detail.includes(victimCard.name)));
  assert.deepEqual(actorView.privateEvents, [], "actor must not see victim's private hand identity");
  assert.deepEqual(sharedView.privateEvents, [], "unscoped serialization must not include private details");
  assert.ok(!JSON.stringify(actorView).includes(victimCard.name), "serialized actor view must not leak victim hand identity");
  assert.ok(!JSON.stringify(sharedView).includes(victimCard.name), "shared announcement must not leak victim hand identity");
  assert.deepEqual(fx.outcome, []);
}

// ── 5. Self-draw remains a genuine actor impact after excluding play cost ────
{
  const base = createGameState("fx-test-self-draw", ["Actor", "Victim"], "facilitated");
  const lifted = liftIntoHand(base, /fresh-air friend/i);
  assert.ok(lifted);
  const { s, card: actionCard } = lifted!;
  const drawn = s.deck[0];
  assert.ok(drawn);
  const before = { ...s, phase: "play" as const };
  const after = {
    ...before,
    deck: before.deck.slice(1),
    discardPile: [...before.discardPile, actionCard],
    players: before.players.map((player, index) =>
      index === 0 ? { ...player, hand: [...player.hand.filter((held) => held.id !== actionCard.id), drawn] } : player
    ),
  };
  const fx = buildEffectAnnouncement(before, after, actionCard, "player_0")!;
  assert.ok(fx.events.some((event) => event.kind === "draw" && event.playerIds?.includes("player_0")), "self-draw must remain a personal consequence");
}

// ── 6. Transfers attribute both pile participants without hand identities ────
{
  const base = createGameState("fx-test-transfer", ["Actor", "Victim"], "facilitated");
  const pileCard = base.deck[0];
  const before = {
    ...base,
    players: base.players.map((player, index) =>
      index === 1 ? { ...player, compostPile: [pileCard] } : player
    ),
  };
  const after = {
    ...before,
    players: before.players.map((player, index) =>
      index === 1
        ? { ...player, compostPile: [] }
        : index === 0
          ? { ...player, compostPile: [pileCard] }
          : player
    ),
  };
  const fx = buildEffectAnnouncement(before, after, null, "player_1")!;
  assert.ok(fx.events.some((event) => event.kind === "transfer" &&
    event.playerIds?.includes("player_0") && event.playerIds.includes("player_1")), "transfer must identify both source and recipient");
}

console.log("effect-announcements.test.ts: all assertions passed ✔");
