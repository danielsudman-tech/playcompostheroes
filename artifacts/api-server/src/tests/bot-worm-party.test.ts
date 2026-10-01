/**
 * Integration tests for Worm Party's per-player choice chain across game modes.
 *
 * Run with: pnpm --filter @workspace/api-server run test:bot-worm-party
 */
import assert from "node:assert/strict";
import { createGameState, playCard, resolveDecision, runBotTurnsIfNeeded } from "../lib/gameEngine.js";

function liftIntoHand(
  state: ReturnType<typeof createGameState>,
  namePattern: RegExp,
  targetIndex = 0
) {
  const deckIdx = state.deck.findIndex((c) => namePattern.test(c.name));
  if (deckIdx >= 0) {
    const card = state.deck[deckIdx];
    const players = state.players.map((player, i) =>
      i === targetIndex ? { ...player, hand: [...player.hand, card] } : player
    );
    return {
      s: { ...state, players, deck: state.deck.filter((_, i) => i !== deckIdx), phase: "play" as const },
      card,
    };
  }
  for (const [pi, player] of state.players.entries()) {
    const handIdx = player.hand.findIndex((c) => namePattern.test(c.name));
    if (handIdx >= 0) {
      const card = player.hand[handIdx];
      const players = state.players.map((pl, i) => {
        if (i === pi && i === targetIndex) return pl;
        if (i === pi) return { ...pl, hand: pl.hand.filter((_, j) => j !== handIdx) };
        if (i === targetIndex) return { ...pl, hand: [...pl.hand, card] };
        return pl;
      });
      return { s: { ...state, players, phase: "play" as const }, card };
    }
  }
  assert.fail(`card matching ${namePattern} not found`);
}

function hands(state: ReturnType<typeof createGameState>): string[][] {
  return state.players.map((player) => player.hand.map((card) => card.id));
}

function assertHandsUnchanged(
  state: ReturnType<typeof createGameState>,
  expected: string[][],
  message: string
) {
  assert.deepEqual(hands(state), expected, message);
}

function chooseNonFirstCard(state: ReturnType<typeof createGameState>, playerId: string): string {
  const player = state.players.find((candidate) => candidate.id === playerId)!;
  assert.ok(player.hand.length > 1, `${player.name} needs multiple cards to test explicit choice`);
  return player.hand[1].id;
}

function resolveHumanChoice(
  state: ReturnType<typeof createGameState>,
  playerId: string,
  cardId: string
) {
  const result = resolveDecision(state, playerId, { cardId });
  assert.equal(result.error, undefined, `choice by ${playerId} failed: ${result.error}`);
  return runBotTurnsIfNeeded(result.state);
}

// Facilitated behavior remains unchanged: the human chooses first, then bots
// drain their own steps before the simultaneous pass is applied.
{
  const base = createGameState("bot-worm-facilitated-test", ["Maria", "RoboBen", "RoboZoe"], "facilitated");
  base.players[1].isBot = true;
  base.players[2].isBot = true;
  const { s, card } = liftIntoHand(base, /worm party/i);
  const played = playCard(s, "player_0", card.id);
  assert.equal(played.error, undefined, played.error);
  const handBefore = hands(played.state);
  let cur = runBotTurnsIfNeeded(played.state);

  assert.equal(cur.pendingDecision?.playerId, "player_0", "first choice belongs to the human actor");
  assertHandsUnchanged(cur, handBefore, "no cards move before all chain choices are made");

  const humanPick = chooseNonFirstCard(cur, "player_0");
  cur = resolveHumanChoice(cur, "player_0", humanPick);
  assert.equal(cur.pendingDecision, null, "bot steps must drain without deadlock");
  assert.ok(cur.log.some((line) => /worm party — cards passed/i.test(line)));
  assert.equal(cur.players[1].hand.some((c) => c.id === humanPick), true);
}

// Standalone local table: two human owners and one bot. Neither human's card
// moves early, each chosen card is honored, and the bot chooses from its own hand.
{
  const base = createGameState(
    "bot-worm-standalone-test",
    ["LocalOne", "LocalTwo", "RoboBen"],
    "standalone",
    [2]
  );
  const { s, card } = liftIntoHand(base, /worm party/i);
  const played = playCard(s, "player_0", card.id);
  assert.equal(played.error, undefined, played.error);
  const handBefore = hands(played.state);
  let cur = runBotTurnsIfNeeded(played.state);

  assert.equal(cur.pendingDecision?.playerId, "player_0", "active human chooses first");
  assertHandsUnchanged(cur, handBefore, "no transfer occurs before either human chooses");
  const firstHumanPick = chooseNonFirstCard(cur, "player_0");
  cur = resolveHumanChoice(cur, "player_0", firstHumanPick);
  assert.equal(cur.pendingDecision?.playerId, "player_1", "next local human gets their own choice");
  assertHandsUnchanged(cur, handBefore, "first human's selection is recorded but not transferred");

  const secondHumanPick = chooseNonFirstCard(cur, "player_1");
  cur = resolveHumanChoice(cur, "player_1", secondHumanPick);
  assert.equal(cur.pendingDecision, null, "bot choice and pass resolve after both humans choose");
  assert.ok(cur.players[1].hand.some((c) => c.id === firstHumanPick));
  assert.ok(cur.players[2].hand.some((c) => c.id === secondHumanPick));
  const receivedBotCard = cur.players[0].hand.find((c) => !handBefore[0].includes(c.id));
  assert.ok(receivedBotCard, "human receives the bot's passed card");
  assert.ok(handBefore[2].includes(receivedBotCard.id), "bot passed a card from its own hand");
  for (let i = 0; i < cur.players.length; i++) {
    assert.equal(cur.players[i].hand.length, handBefore[i].length, "pass cycle preserves hand sizes");
  }
  assert.equal(cur.currentPlayerIndex, 0, "a human Worm Party does not advance the current turn");
}

// Online room: one human and one bot still use the same explicit-choice chain.
{
  const base = createGameState("bot-worm-online-test", ["OnlineHuman", "RoboBen"], "online", [1]);
  const { s, card } = liftIntoHand(base, /worm party/i);
  const played = playCard(s, "player_0", card.id);
  assert.equal(played.error, undefined, played.error);
  const handBefore = hands(played.state);
  let cur = runBotTurnsIfNeeded(played.state);

  assert.equal(cur.pendingDecision?.playerId, "player_0");
  assertHandsUnchanged(cur, handBefore, "online hands do not change before the human choice");
  const humanPick = chooseNonFirstCard(cur, "player_0");
  cur = resolveHumanChoice(cur, "player_0", humanPick);
  assert.equal(cur.pendingDecision, null, "online bot choice drains without stalling");
  assert.ok(cur.players[1].hand.some((c) => c.id === humanPick));
  assert.equal(cur.players[0].hand.length, handBefore[0].length);
  assert.equal(cur.players[1].hand.length, handBefore[1].length);
}

// Consecutive bots can make their own choices before Worm Party hands off to
// humans; the bot turn stays open and advances normally once the chain ends.
{
  const base = createGameState(
    "bot-worm-consecutive-bots-test",
    ["LocalOne", "LocalTwo", "RoboBen", "RoboZoe"],
    "standalone",
    [2, 3],
    { 3: "easy" }
  );
  let { s, card: wormParty } = liftIntoHand(base, /worm party/i, 2);
  const soggy = liftIntoHand(s, /soggy pile/i, 2);
  s = soggy.s;
  const stinky = liftIntoHand(s, /stinky pile/i, 2);
  s = stinky.s;
  const botCardIds = [wormParty.id, soggy.card.id, stinky.card.id];
  const bot = s.players[2];
  s = {
    ...s,
    currentPlayerIndex: 2,
    phase: "play",
    players: s.players.map((player, index) =>
      index === 2
        ? { ...player, hand: bot.hand.filter((candidate) => botCardIds.includes(candidate.id)) }
        : player
    ),
    deck: [...s.deck, ...bot.hand.filter((candidate) => !botCardIds.includes(candidate.id))],
  };
  const availableCards = [
    ...s.players.flatMap((player, index) => index === 2 ? [] : player.hand),
    ...s.deck,
  ];
  const replacementActionCards = availableCards
    .filter((candidate) => candidate.type === "action" && !botCardIds.includes(candidate.id))
    .slice(0, 8);
  assert.equal(replacementActionCards.length, 8, "test deck needs eight non-starter action cards");
  const replacementIds = new Set(replacementActionCards.map((candidate) => candidate.id));
  s = {
    ...s,
    players: s.players.map((player, index) =>
      index === 0
        ? { ...player, hand: replacementActionCards.slice(0, 3) }
        : index === 1
          ? { ...player, hand: replacementActionCards.slice(3, 6) }
          : index === 3
            ? { ...player, hand: replacementActionCards.slice(6, 8) }
        : player
    ),
    deck: availableCards.filter((candidate) => !replacementIds.has(candidate.id)),
  };
  const handBeforeTurn = hands(s);
  const handBefore = handBeforeTurn.map((hand, index) =>
    index === 2 ? hand.filter((cardId) => cardId !== wormParty.id) : hand
  );
  let cur = runBotTurnsIfNeeded(s);

  assert.equal(cur.pendingDecision?.playerId, "player_0", "both bots choose before the human handoff");
  const choices = cur.pendingDecision?.meta?.chosen as Record<string, string>;
  const firstBotChoice = choices?.player_2;
  const secondBotChoice = choices?.player_3;
  assert.ok(firstBotChoice && handBefore[2].includes(firstBotChoice), "starter bot chooses from its own hand");
  assert.ok(secondBotChoice && handBefore[3].includes(secondBotChoice), "next bot chooses from its own hand");
  assert.ok(cur.log.some((line) => /worm party/i.test(line)), "bot played Worm Party");
  assert.equal(cur.currentPlayerIndex, 2, "starter bot turn remains active during the human handoff");
  assertHandsUnchanged(cur, handBefore, "bot choices are recorded without moving cards early");

  const firstHumanPick = chooseNonFirstCard(cur, "player_0");
  cur = resolveHumanChoice(cur, "player_0", firstHumanPick);
  assert.equal(cur.pendingDecision?.playerId, "player_1");
  assert.equal(cur.currentPlayerIndex, 2, "bot turn stays open for the second human choice");
  assertHandsUnchanged(cur, handBefore, "first human choice does not apply the pass early");

  const secondHumanPick = chooseNonFirstCard(cur, "player_1");
  cur = resolveHumanChoice(cur, "player_1", secondHumanPick);
  assert.equal(cur.pendingDecision, null, "the Worm Party chain completes after human handoff");
  assert.ok(cur.players[1].hand.some((candidate) => candidate.id === firstHumanPick));
  assert.ok(cur.players[2].hand.some((candidate) => candidate.id === secondHumanPick));
  assert.ok(cur.players[3].hand.some((candidate) => candidate.id === firstBotChoice));
  assert.ok(cur.players[0].hand.some((candidate) => candidate.id === secondBotChoice));
  assert.equal(cur.currentPlayerIndex, 0, "both bot turns advance normally after the chain resolves");
  assert.equal(cur.turnNumber, 3, "the two bot turns finish before the first human turn");
  assert.equal(cur.phase, "draw", "the next human player's turn begins after the pass");
}

console.log("bot-worm-party.test.ts: all assertions passed ✔");
