import assert from "node:assert/strict";
import { captureEngineOperations, createGameState, runBotTurnsIfNeeded, type GameState } from "../lib/gameEngine.js";
import { buildEffectAnnouncement, serializeEffectAnnouncement } from "../lib/facilitatedEffects.js";
import { serializeState } from "../routes/game.js";
function card(state: GameState, base: string) {
  const found = [...state.deck, ...state.players.flatMap(p => p.hand)].find(c => (c.baseId ?? c.id.split("__")[0]) === base);
  assert.ok(found, base);
  return found;
}
{
  const state = createGameState("bot-legion-update", ["Sam", "Bot", "Alex"], "online");
  const legion = card(state, "legion_of_life"), hot = card(state, "hot_pile_bonus");
  state.players = state.players.map((p, i) => ({ ...p, hand: i === 1 ? [legion] : [], compostPile: [], isBot: i === 1, botSkillLevel: "medium" }));
  state.currentPlayerIndex = 1;
  state.deck = [];
  state.ongoingActionCard = hot;
  const result = captureEngineOperations(state, () => ({ state: runBotTurnsIfNeeded(state) }));
  const play = result.trace.plays?.find(p => p.card.id === legion.id);
  assert.ok(play, "engine records the actual Legion play");
  assert.equal(result.trace.plays?.length, 1, "nested traces do not duplicate plays");
  assert.equal(result.trace.plays?.some(p => p.card.id === hot.id), false, "removed Hot Pile was not played");
  const effect = buildEffectAnnouncement(state, result.result.state, play.card, play.playerId, "played", result.trace);
  assert.equal(effect?.cardName, legion.name);
  assert.ok(serializeEffectAnnouncement(effect, "player_0", true)?.events.some(event => event.text.includes(hot.name) && event.text.includes("removed")));
  const update = result.result.state.botTurnUpdates?.[0];
  assert.equal(update?.cardName, legion.name);
  assert.ok(update?.removalLine?.includes(`${hot.name} was removed`));
  assert.equal(result.result.state.currentPlayerIndex, 2);
}
{
  const state = createGameState("bot-draw-pass", ["Sam", "Bot", "Bot2", "Alex"], "online");
  const secret = card(state, "hot_pile_bonus"), second = card(state, "worm_party");
  state.players = state.players.map((p, i) => ({ ...p, hand: [], compostPile: [], isBot: i === 1 || i === 2, botSkillLevel: "easy" }));
  state.deck = [secret, second];
  state.currentPlayerIndex = 1;
  const captured = captureEngineOperations(state, () => ({ state: runBotTurnsIfNeeded(state) }));
  const next = captured.result.state;
  assert.equal(captured.trace.draws.length, 2, "nested traces record each bot draw once");
  assert.equal(next.botTurnUpdates?.length, 2);
  assert.ok(next.botTurnUpdates?.every(u => u.summary.includes("drew a card and passed")));
  assert.ok(next.botTurnUpdates?.every(u => !u.cardName && !u.summary.includes(secret.name) && !u.summary.includes(second.name)));
  assert.equal(new Set(next.botTurnUpdates?.map(u => u.id)).size, 2);
  assert.ok(serializeState(next, 0).players[1].hand.every(c => c.id === "back"));
}
console.log("bot-turn-updates.test.ts: actual Legion attribution, ongoing removal, per-bot draw/pass and hand privacy passed");