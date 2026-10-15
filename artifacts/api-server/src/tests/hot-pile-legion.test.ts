import assert from "node:assert/strict";
import {
  activateOngoing,
  createGameState,
  drawCardAction,
  endTurn,
  playCard,
  resolveDecision,
  runBotTurnsIfNeeded,
} from "../lib/gameEngine.js";
import type { GameState } from "../lib/gameEngine.js";
import type { Card } from "../lib/cards.js";
import { reloadGameState, storeGame } from "../lib/gameStore.js";

function takeCard(state: GameState, baseId: string): [GameState, Card] {
  const matches = (card: Card) => (card.baseId ?? card.id.split("__", 1)[0]) === baseId;
  const deckIndex = state.deck.findIndex(matches);
  if (deckIndex >= 0) {
    const card = state.deck[deckIndex];
    return [{ ...state, deck: state.deck.filter((_, index) => index !== deckIndex) }, card];
  }
  for (const player of state.players) {
    const handIndex = player.hand.findIndex(matches);
    if (handIndex >= 0) {
      const card = player.hand[handIndex];
      return [{
        ...state,
        players: state.players.map((candidate) =>
          candidate.id === player.id
            ? { ...candidate, hand: candidate.hand.filter((_, index) => index !== handIndex) }
            : candidate,
        ),
      }, card];
    }
  }
  throw new Error(`Could not find a ${baseId} card in the game`);
}

function putInCompost(
  state: GameState,
  baseId: string,
  playerId: string,
  chosenFunction?: string,
): [GameState, Card] {
  let card: Card;
  [state, card] = takeCard(state, baseId);
  const placed = chosenFunction ? { ...card, chosenFunction } : card;
  return [{
    ...state,
    players: state.players.map((player) =>
      player.id === playerId ? { ...player, compostPile: [...player.compostPile, placed] } : player,
    ),
  }, placed];
}

function setHotPile(
  state: GameState,
  appliedByPlayerId = "player_0",
  omitBaseId = false,
): [GameState, Card] {
  let card: Card;
  [state, card] = takeCard(state, "hot_pile_bonus");
  if (omitBaseId) card = { ...card, baseId: undefined };
  return [{
    ...state,
    ongoingActionCard: card,
    activeModifiers: [
      ...state.activeModifiers.filter((modifier) => modifier.cardId !== "hot_pile_bonus"),
      {
        cardId: card.baseId ?? card.id.split("__", 1)[0],
        cardName: card.name,
        effect: card.cardText,
        appliedByPlayerId,
      },
    ],
  }, card];
}

function cardCopiesInPlay(state: GameState, baseId: string): number {
  const allCards = [
    ...state.deck,
    ...state.discardPile,
    ...(state.ongoingActionCard ? [state.ongoingActionCard] : []),
    ...state.players.flatMap((player) => [...player.hand, ...player.compostPile]),
  ];
  return allCards.filter((card) => (card.baseId ?? card.id.split("__", 1)[0]) === baseId).length;
}

function playLegion(state: GameState, legion: Card): GameState {
  const first = playCard(state, "player_0", legion.id);
  assert.equal(first.error, undefined, first.error);
  assert.equal(first.state.pendingDecision?.type, "choose_function");
  const result = resolveDecision(first.state, "player_0", { function: "Nitrogen" });
  assert.equal(result.error, undefined, result.error);
  return result.state;
}

// Alternate-function heroes count while they're placed in another slot.
{
  let state = createGameState("hot-pile-alternate-slot", ["Alex", "Bea"], "facilitated");
  [state] = putInCompost(state, "microbial_marshal", "player_1", "Nitrogen");
  [state] = putInCompost(state, "actinomycetes", "player_1");
  [state] = setHotPile(state, "player_0");
  state = { ...state, phase: "play", currentPlayerIndex: 1 };

  const player = state.players[1];
  assert.equal(
    player.compostPile.filter((card) =>
      (card.chosenFunction ?? card.function) === "Decomposer" ||
      card.function === "Decomposer" ||
      card.alternateFunctions?.includes("Decomposer"),
    ).length,
    2,
    "the current slot or an alternate slot qualifies each card once",
  );
  const deckBefore = state.deck.length;
  const handBefore = player.hand.length;
  const activation = activateOngoing(state, "player_1");
  assert.equal(activation.error, undefined, activation.error);
  assert.equal(activation.state.deck.length, deckBefore - 1, "Hot Pile draws exactly one card");
  assert.equal(activation.state.players[1].hand.length, handBefore + 1);
  assert.equal(activation.state.ongoingBenefitUsedThisTurn, true);
  assert.equal(activation.state.players[1].drawsExtraCard, false, "Hot Pile is not a passive per-turn draw flag");
  assert.equal(
    activateOngoing(activation.state, "player_1").error,
    "You have already used Hot Pile Bonus's benefit this turn",
    "a player other than the player who set the ongoing card can activate it only once",
  );

  const endFirst = endTurn(activation.state, "player_1");
  assert.equal(endFirst.error, undefined);
  const endSecond = endTurn(endFirst.state, "player_0");
  assert.equal(endSecond.error, undefined);
  const nextPlayerDraw = drawCardAction(endSecond.state, "player_1");
  assert.equal(nextPlayerDraw.error, undefined);
  assert.equal(nextPlayerDraw.state.ongoingBenefitUsedThisTurn, false);
  const nextTurnDeck = nextPlayerDraw.state.deck.length;
  const nextTurnHand = nextPlayerDraw.state.players[1].hand.length;
  const nextTurnActivation = activateOngoing(nextPlayerDraw.state, "player_1");
  assert.equal(nextTurnActivation.error, undefined, nextTurnActivation.error);
  assert.equal(nextTurnActivation.state.deck.length, nextTurnDeck - 1);
  assert.equal(nextTurnActivation.state.players[1].hand.length, nextTurnHand + 1);
}

// Bots and people share activation's same count rule, including the alternate
// function of a hero played in a different slot.
{
  let state = createGameState(
    "hot-pile-bot-eligibility",
    ["Bot", "Human"],
    "facilitated",
    [0],
    { 0: "easy" },
  );
  [state] = putInCompost(state, "microbial_marshal", "player_0", "Nitrogen");
  [state] = putInCompost(state, "actinomycetes", "player_0");
  [state] = setHotPile(state, "player_1", true);
  let guaranteedActionDraw: Card;
  [state, guaranteedActionDraw] = takeCard(state, "high_heat_gamble");
  state = {
    ...state,
    phase: "play",
    deck: [guaranteedActionDraw],
    players: state.players.map((player, index) =>
      index === 0 ? { ...player, hand: [] } : player,
    ),
  };
  const botAfterTurn = runBotTurnsIfNeeded(state);
  assert.equal(botAfterTurn.players[0].hand.length, 1, "the qualifying bot draws one bonus card");
  assert.equal(botAfterTurn.currentPlayerIndex, 1, "the bot finishes its turn after activation");
}

// Regression contract: Legion removes the actual in-play instance rather than
// adding a template copy to the discard pile and leaving the real one active.
{
  let state = createGameState("legion-instance-regression", ["Alex", "Bea"], "facilitated");
  let legion: Card;
  [state, legion] = takeCard(state, "legion_of_life");
  legion = { ...legion, baseId: undefined };
  let hotPile: Card;
  [state, hotPile] = setHotPile(state, "player_0", true);
  state = {
    ...state,
    phase: "play",
    players: state.players.map((player, index) =>
      index === 0 ? { ...player, hand: [...player.hand, legion] } : player,
    ),
  };
  const copiesBefore = cardCopiesInPlay(state, "hot_pile_bonus");
  assert.equal(copiesBefore, 1);
  const resultState = playLegion(state, legion);
  assert.equal(
    resultState.discardPile[0]?.id,
    hotPile.id,
    "Legion must discard the real ongoing Hot Pile instance, not a template copy",
  );
  assert.equal(resultState.ongoingActionCard, null, "Legion must clear the ongoing card");
  assert.ok(
    !resultState.activeModifiers.some((modifier) => modifier.cardId === hotPile.baseId),
    "Legion must clear the ongoing modifier",
  );
  assert.equal(cardCopiesInPlay(resultState, "hot_pile_bonus"), copiesBefore);
  assert.equal(
    activateOngoing(resultState, "player_0").error,
    "No ongoing action card is active",
    "the removed Hot Pile cannot be activated again",
  );
}

// Legacy failed-Legion saves can retain the real ongoing instance after its
// modifier has already been removed. The instance remains authoritative.
{
  let state = createGameState("legion-legacy-missing-modifier", ["Alex", "Bea"], "facilitated");
  let legion: Card;
  [state, legion] = takeCard(state, "legion_of_life");
  let hotPile: Card;
  [state, hotPile] = setHotPile(state, "player_0", true);
  state = {
    ...state,
    phase: "play",
    activeModifiers: [],
    players: state.players.map((player, index) =>
      index === 0 ? { ...player, hand: [...player.hand, legion] } : player,
    ),
  };

  const resultState = playLegion(state, legion);
  assert.equal(resultState.discardPile[0]?.id, hotPile.id);
  assert.equal(resultState.ongoingActionCard, null);
  assert.equal(resultState.activeModifiers.length, 0);
}

// Older snapshots may store the ongoing instance ID in activeModifiers rather
// than its canonical base ID; Legion removes that entry but preserves others.
{
  let state = createGameState("legion-legacy-instance-modifier", ["Alex", "Bea"], "facilitated");
  let legion: Card;
  [state, legion] = takeCard(state, "legion_of_life");
  let hotPile: Card;
  [state, hotPile] = setHotPile(state, "player_0", true);
  state = {
    ...state,
    phase: "play",
    activeModifiers: [
      { ...state.activeModifiers[0], cardId: hotPile.id },
      {
        cardId: "unrelated_modifier",
        cardName: "Unrelated Modifier",
        effect: "",
        appliedByPlayerId: "player_1",
      },
    ],
    players: state.players.map((player, index) =>
      index === 0 ? { ...player, hand: [...player.hand, legion] } : player,
    ),
  };

  const resultState = playLegion(state, legion);
  assert.equal(resultState.discardPile[0]?.id, hotPile.id);
  assert.equal(resultState.ongoingActionCard, null);
  assert.deepEqual(
    resultState.activeModifiers.map((modifier) => modifier.cardId),
    ["unrelated_modifier"],
  );
}

// Legion is exempt from Plastic Contamination and removes that real instance.
{
  let state = createGameState("legion-removes-plastic", ["Alex", "Bea"], "facilitated");
  let legion: Card;
  [state, legion] = takeCard(state, "legion_of_life");
  legion = { ...legion, baseId: undefined };
  let plastic: Card;
  [state, plastic] = takeCard(state, "plastic_contamination");
  plastic = { ...plastic, baseId: undefined };
  state = {
    ...state,
    phase: "play",
    ongoingActionCard: plastic,
    activeModifiers: [{
      cardId: plastic.id.split("__", 1)[0],
      cardName: plastic.name,
      effect: plastic.cardText,
      appliedByPlayerId: "player_1",
    }],
    players: state.players.map((player, index) =>
      index === 0 ? { ...player, hand: [...player.hand, legion] } : player,
    ),
  };
  const resultState = playLegion(state, legion);
  assert.equal(resultState.ongoingActionCard, null);
  assert.equal(resultState.discardPile[0]?.id, plastic.id);
  assert.ok(!resultState.activeModifiers.some((modifier) => modifier.cardId === "plastic_contamination"));
}

// Playing a new ongoing action replaces and discards Hot Pile exactly once.
{
  let state = createGameState("ongoing-replacement", ["Alex", "Bea"], "facilitated");
  let hotPile: Card;
  [state, hotPile] = setHotPile(state, "player_0", true);
  let nitrogenBoost: Card;
  [state, nitrogenBoost] = takeCard(state, "nitrogen_boost");
  state = {
    ...state,
    phase: "play",
    players: state.players.map((player, index) =>
      index === 0 ? { ...player, hand: [...player.hand, nitrogenBoost] } : player,
    ),
  };
  const result = playCard(state, "player_0", nitrogenBoost.id);
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.state.ongoingActionCard?.id, nitrogenBoost.id);
  assert.equal(result.state.discardPile[0]?.id, hotPile.id);
  assert.ok(!result.state.activeModifiers.some((modifier) => modifier.cardId === "hot_pile_bonus"));
  assert.equal(cardCopiesInPlay(result.state, "hot_pile_bonus"), 1);
}

// Save and reload through the same JSON contract as gameStore without using a
// real database connection.
{
  let state = createGameState("hot-pile-save-reload", ["Alex", "Bea"], "facilitated");
  [state] = putInCompost(state, "actinomycetes", "player_0");
  [state] = putInCompost(state, "catalyst", "player_0");
  [state] = setHotPile(state);
  state = { ...state, phase: "play" };
  const activated = activateOngoing(state, "player_0");
  assert.equal(activated.error, undefined, activated.error);

  let savedState = "";
  const fakeClient = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("INSERT INTO compost_games")) {
        savedState = String(values?.[1]);
        return { rows: [] };
      }
      if (sql.startsWith("SELECT state FROM compost_games")) {
        return { rows: savedState ? [{ state: savedState }] : [] };
      }
      throw new Error(`Unexpected save/reload query: ${sql}`);
    },
  } as never;
  await storeGame(activated.state, fakeClient);
  const reloaded = await reloadGameState(activated.state.gameId, fakeClient);
  assert.ok(reloaded);
  assert.equal(reloaded?.ongoingActionCard?.baseId, "hot_pile_bonus");
  assert.equal(reloaded?.ongoingBenefitUsedThisTurn, true);
  assert.equal(
    activateOngoing(reloaded!, "player_0").error,
    "You have already used Hot Pile Bonus's benefit this turn",
  );
}

console.log("hot-pile-legion.test.ts: all assertions passed");