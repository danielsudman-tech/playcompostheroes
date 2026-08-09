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
import { buildEffectAnnouncement, findEffectCard } from "../lib/facilitatedEffects.js";
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

console.log("effect-announcements.test.ts: all assertions passed ✔");
