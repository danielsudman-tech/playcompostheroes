/**
 * Regression coverage for bot turn takeover boundaries.
 *
 * Run with: pnpm --filter @workspace/api-server run test:bot-takeover
 */
import assert from "node:assert/strict";
import {
  createGameState,
  resolveDecision,
  runBotTurnsIfNeeded,
} from "../lib/gameEngine.js";

function makeBotCurrent(state = createGameState("bot-takeover", ["Bot", "Human"], "facilitated")) {
  state.players[0].isBot = true;
  state.players[0].botSkillLevel = "easy";
  state.currentPlayerIndex = 0;
  return state;
}

// A bot must not advance its play-phase turn while a different human owns a
// pending decision. Once that human resolves it, the route's bot pipeline can
// resume the bot's already-drawn turn.
{
  let state = makeBotCurrent();
  state.phase = "play";
  state.players[0].hand = [];
  state.pendingDecision = {
    type: "choose_target_player",
    playerId: "player_1",
    cardId: "test-choice",
    options: [{ playerId: "player_0" }],
    prompt: "Human choice",
  };
  const waiting = runBotTurnsIfNeeded(state);
  assert.equal(waiting.pendingDecision?.playerId, "player_1");
  assert.equal(waiting.currentPlayerIndex, 0);
  assert.equal(waiting.turnNumber, state.turnNumber);

  const resolved = resolveDecision(waiting, "player_1", { targetPlayerId: "player_0" });
  assert.equal(resolved.error, undefined);
  const resumed = runBotTurnsIfNeeded(resolved.state);
  assert.equal(resumed.pendingDecision, null);
  assert.notEqual(resumed.currentPlayerIndex, 0, "bot should finish its play-phase turn");
}

// A takeover with a bot-owned pending decision must drain and progress from
// intermediate phases too; it must neither draw a second card nor stall.
for (const phase of ["effect_resolution", "end_turn"] as const) {
  const state = makeBotCurrent();
  state.phase = phase;
  state.players[0].hand = [];
  const actionCardIndex = state.deck.findIndex((card) => card.type === "action");
  assert.ok(actionCardIndex >= 0, "deck has an action card for the pending choice");
  const [actionCard] = state.deck.splice(actionCardIndex, 1);
  state.discardPile.push(actionCard);
  state.pendingDecision = {
    type: "choose_card_from_discard",
    playerId: "player_0",
    cardId: "test-choice",
    options: [{ cardId: actionCard.id }],
    prompt: "Bot choice",
  };

  const progressed = runBotTurnsIfNeeded(state);
  assert.equal(progressed.pendingDecision, null);
  assert.equal(progressed.currentPlayerIndex, 1, `bot turn should finish in ${phase}`);
  assert.equal(progressed.phase, "draw");
}

console.log("bot-takeover.test.ts: all assertions passed ✔");