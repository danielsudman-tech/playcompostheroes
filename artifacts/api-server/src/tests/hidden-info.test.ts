/**
 * Integration test for the multiplayer hidden-information contract
 * (online + facilitated modes):
 *
 *  1. Non-owner viewers must NOT see another player's hand card identities.
 *  2. A pending decision's options/meta (which can be hand-derived, e.g.
 *     Worm Party) are visible ONLY to the decision owner.
 *  3. The decision owner can still resolve the decision from their options.
 *
 * Run with: pnpm --filter @workspace/api-server run test:hidden-info
 */
import assert from "node:assert/strict";
import { createGameState, playCard, resolveDecision } from "../lib/gameEngine.js";
import { serializeState } from "../routes/game.js";

/** Move the first card matching namePattern (from deck or any hand) into player_0's hand. */
function findAndLift(state: ReturnType<typeof createGameState>, namePattern: RegExp) {
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
      const players = state.players.map((pl, i) => {
        if (i === pi && i === 0) return pl; // already in player_0's hand
        if (i === pi) return { ...pl, hand: pl.hand.filter((_, j) => j !== hi) };
        return pl;
      });
      if (pi !== 0) players[0] = { ...players[0], hand: [...players[0].hand, card] };
      return { s: { ...state, players, phase: "play" as const }, card };
    }
  }
  assert.fail(`card matching ${namePattern} not found in deck or hands`);
}

// ── Setup: facilitated 3-player game, force Worm Party into Maria's hand ─────
let base = createGameState("hidden-info-test", ["Maria", "Ben", "Zoe"], "facilitated");
const { s, card: wormParty } = findAndLift(base, /worm party/i);

const played = playCard(s, "player_0", wormParty.id);
assert.equal(played.error, undefined, `playCard failed: ${played.error}`);
const state = played.state;
assert.ok(state.pendingDecision, "Worm Party should create a pending decision");
const owner = state.pendingDecision!.playerId;
const ownerIndex = state.players.findIndex((p) => p.id === owner);
const otherIndex = (ownerIndex + 1) % state.players.length;

// ── 1. Hand hiding ────────────────────────────────────────────────────────────
const otherView = serializeState(state, otherIndex);
for (const [i, p] of otherView.players.entries()) {
  if (i === otherIndex) continue;
  for (const c of p.hand) {
    assert.equal(c.name, "Card Back", `viewer ${otherIndex} must not see ${state.players[i].name}'s hand`);
  }
}

// ── 2. Decision option redaction ─────────────────────────────────────────────
const ownerView = serializeState(state, ownerIndex);
assert.ok((ownerView.pendingDecision?.options ?? []).length > 0, "owner must see legal options");

assert.deepEqual(otherView.pendingDecision?.options, [], "non-owner must not see decision options");
assert.equal(otherView.pendingDecision?.meta, undefined, "non-owner must not see decision meta");
assert.ok(otherView.pendingDecision?.prompt, "non-owner still sees the prompt for the waiting UI");
assert.equal(otherView.pendingDecision?.playerId, owner, "non-owner still sees who is deciding");

const unauthView = serializeState(state); // no viewerIndex = unauthenticated
assert.deepEqual(unauthView.pendingDecision?.options, [], "unauthenticated viewer must not see options");
for (const p of unauthView.players) {
  for (const c of p.hand) {
    assert.equal(c.name, "Card Back", "unauthenticated viewer must not see any hand");
  }
}

// ── 3. Non-owner resolution is rejected by the engine ────────────────────────
const firstOption = ownerView.pendingDecision!.options![0] as { cardId?: string };
assert.ok(firstOption.cardId, "hand-choice option should carry a cardId for the owner");
const hijack = resolveDecision(state, state.players[otherIndex].id, { cardId: firstOption.cardId });
assert.ok(hijack.error, "engine must reject a non-owner resolving the decision");

// ── 4. Full Worm Party chain: EVERY player with cards gets their own guided
//       decision; at each step only the owner sees options, others are
//       redacted (waiting state), and the owner resolves their own choice. ───
let cur = state;
const deciders: string[] = [];
let guard = 0;
while (cur.pendingDecision && guard++ < 10) {
  const d = cur.pendingDecision;
  deciders.push(d.playerId);
  const oIdx = cur.players.findIndex((p) => p.id === d.playerId);
  for (let v = 0; v < cur.players.length; v++) {
    const view = serializeState(cur, v);
    if (v === oIdx) {
      assert.ok((view.pendingDecision?.options ?? []).length > 0, "step owner must see options");
    } else {
      assert.deepEqual(view.pendingDecision?.options, [], "non-owner must be redacted at every step");
      assert.ok(view.pendingDecision?.prompt, "non-owner sees waiting prompt");
    }
  }
  const ownerP = cur.players.find((p) => p.id === d.playerId)!;
  const pick = ownerP.hand[0].id;
  const rr = resolveDecision(cur, d.playerId, { cardId: pick, cardIds: [pick] });
  assert.equal(rr.error, undefined, `owner resolve failed: ${rr.error}`);
  cur = rr.state;
}
const expectedDeciders = state.players.filter((p) => p.hand.length > 0).map((p) => p.id);
assert.deepEqual(
  [...deciders].sort(),
  [...expectedDeciders].sort(),
  "every player with cards must get their own Worm Party decision (no auto-picks)"
);
assert.equal(cur.pendingDecision, null, "chain must complete");

console.log("hidden-info.test.ts: all assertions passed ✔");
