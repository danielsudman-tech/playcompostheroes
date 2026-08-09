/**
 * Integration test: facilitated room containing bots completes the Worm Party
 * sequential decision chain through the same pipeline the action route uses
 * (resolveDecision for the human + runBotTurnsIfNeeded to drain bot decisions).
 *
 * Guards against: bot auto-resolution bypassing the wormChain metadata and
 * auto-picking other players' cards or deadlocking the chain.
 *
 * Run with: pnpm --filter @workspace/api-server run test:bot-worm-party
 */
import assert from "node:assert/strict";
import { createGameState, playCard, resolveDecision, runBotTurnsIfNeeded } from "../lib/gameEngine.js";

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
  assert.fail(`card matching ${namePattern} not found`);
}

// Facilitated 3-player game: human host + two bots (as created via the waiting-room bot UI)
const base = createGameState("bot-worm-test", ["Maria", "RoboBen", "RoboZoe"], "facilitated");
base.players[1].isBot = true;
base.players[2].isBot = true;
const { s, card } = liftIntoHand(base, /worm party/i);

const handBefore = s.players.map((p) => p.hand.filter((c) => c.id !== card.id).map((c) => c.id));

const played = playCard(s, "player_0", card.id);
assert.equal(played.error, undefined, played.error);
// Route pipeline: after any action, bot decisions are drained.
let cur = runBotTurnsIfNeeded(played.state);

// The first chain decision belongs to the human actor — bots must NOT have
// auto-resolved it or auto-picked anyone's cards yet.
assert.ok(cur.pendingDecision, "human's chain step must still be pending");
assert.equal(cur.pendingDecision!.playerId, "player_0", "first decision belongs to the human actor");
for (let i = 0; i < cur.players.length; i++) {
  assert.deepEqual(
    cur.players[i].hand.map((c) => c.id).sort(),
    handBefore[i].sort(),
    "no cards may move before the chain completes"
  );
}

// Human resolves; route then drains bot decisions.
const humanPick = cur.players[0].hand[0].id;
const rr = resolveDecision(cur, "player_0", { cardId: humanPick, cardIds: [humanPick] });
assert.equal(rr.error, undefined, `human resolve failed: ${rr.error}`);
cur = runBotTurnsIfNeeded(rr.state);

// Chain must be fully drained (bots resolved their own steps via the chain,
// simultaneous pass applied at the end) with no deadlock.
assert.equal(cur.pendingDecision, null, "bot chain steps must drain without deadlock");
assert.ok(
  cur.log.some((l) => /worm party — cards passed/i.test(l)),
  "simultaneous pass must have been applied"
);
// Each player passed exactly one card left: hand sizes unchanged, contents shifted.
for (let i = 0; i < cur.players.length; i++) {
  assert.equal(cur.players[i].hand.length, handBefore[i].length, "hand sizes preserved by the pass cycle");
}
// The human's chosen card must now be in the left neighbor's hand (their own choice was honored).
assert.ok(
  cur.players[1].hand.some((c) => c.id === humanPick),
  "human's explicitly chosen card must be the one passed left"
);

console.log("bot-worm-party.test.ts: all assertions passed ✔");
