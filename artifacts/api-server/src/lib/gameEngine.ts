import { Card, buildDeck, WIN_FUNCTIONS, getAllCards } from "./cards.js";
import { getAllOverrides } from "./imageKeyStore.js";
import { getAllCopies } from "./cardCopiesStore.js";

export interface PlayerState {
  id: string;
  name: string;
  hand: Card[];
  compostPile: Card[];
  skipsNextTurn: boolean;
  maxHandSize: number;
  drawsExtraCard: boolean;
  isBot: boolean;
}

export interface ActiveModifier {
  cardId: string;
  cardName: string;
  effect: string;
  appliedByPlayerId: string;
}

export type DecisionType =
  | "choose_target_player"
  | "choose_card_from_discard"
  | "choose_card_from_hand"
  | "choose_card_from_compost"
  | "choose_card_to_swap_compost"
  | "choose_opponent_for_steal"
  | "choose_steal_card"
  | "choose_card_from_opponent_compost"
  | "choose_cards_for_worm_party"
  | "choose_worm_party_card"
  | "choose_discard_for_spread"
  | "choose_soggy_pile_discard"
  | "choose_rot_roulette_keep"
  | "choose_rainstorm_play"
  | "choose_hero_from_discard"
  | "choose_swap_opponent_breezy"
  | "choose_swap_their_card_breezy"
  | "choose_swap_my_card_breezy"
  | "choose_compost_to_swap_breezy"
  | "choose_under_web_hand_card"
  | "choose_under_web_discard_card"
  | "choose_rot_regrow_discard"
  | "choose_nitrogen_boost_discard"
  | "choose_function"
  | "choose_move_function"
  | "choose_rot_regrow_take"
  | "choose_discard_to_limit";

export interface PendingDecision {
  type: DecisionType;
  playerId: string;
  cardId: string;
  options?: unknown[];
  prompt: string;
  meta?: Record<string, unknown>;
}

export type GamePhase =
  | "waiting"
  | "setup"
  | "draw"
  | "play"
  | "effect_resolution"
  | "end_turn"
  | "game_over";

export interface GameState {
  gameId: string;
  mode: "facilitator" | "standalone" | "online";
  phase: GamePhase;
  currentPlayerIndex: number;
  players: PlayerState[];
  deck: Card[];
  discardPile: Card[];
  activeModifiers: ActiveModifier[];
  pendingDecision: PendingDecision | null;
  log: string[];
  winner: string | null;
  turnNumber: integer;
  extraTurn: boolean;
  heroPlayedThisTurn: boolean;
  actionPlayedThisTurn: boolean;
  ongoingActionCard: Card | null;
  /** True once the current player has already activated their ongoing-action-card benefit this turn. */
  ongoingBenefitUsedThisTurn: boolean;
  maxPlayers?: number;
}

type integer = number;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function addLog(state: GameState, msg: string): void {
  state.log = [...state.log.slice(-49), msg];
}

function drawCard(
  state: GameState,
  player: PlayerState,
  count = 1
): GameState {
  let s = { ...state };
  for (let i = 0; i < count; i++) {
    if (s.deck.length === 0) {
      if (s.discardPile.length === 0) {
        addLog(s, "Deck and discard pile are both empty — no card to draw.");
        break;
      }
      // Reshuffle discard into deck
      s = {
        ...s,
        deck: shuffle(s.discardPile),
        discardPile: [],
      };
      addLog(s, "Deck empty — reshuffled discard pile into deck.");
    }
    const [card, ...rest] = s.deck;
    const updatedPlayer = {
      ...player,
      hand: [...player.hand, card],
    };
    player = updatedPlayer;
    s = {
      ...s,
      deck: rest,
      players: s.players.map((p) => (p.id === player.id ? updatedPlayer : p)),
    };
  }
  return s;
}

function getPlayer(state: GameState, playerId: string): PlayerState | undefined {
  return state.players.find((p) => p.id === playerId);
}

function updatePlayer(state: GameState, updated: PlayerState): GameState {
  return {
    ...state,
    players: state.players.map((p) => (p.id === updated.id ? updated : p)),
  };
}

function enforceHandSize(state: GameState): GameState {
  // Trim hands that exceed maxHandSize (owner must discard; for now auto-discard last cards)
  let s = state;
  for (const originalPlayer of s.players) {
    // Always re-read from current state to get up-to-date hand
    let currentPlayer = s.players.find((p) => p.id === originalPlayer.id)!;
    while (currentPlayer.hand.length > currentPlayer.maxHandSize) {
      const discarded = currentPlayer.hand[currentPlayer.hand.length - 1];
      const updatedPlayer = {
        ...currentPlayer,
        hand: currentPlayer.hand.slice(0, -1),
      };
      s = {
        ...s,
        discardPile: [...s.discardPile, discarded],
        players: s.players.map((p) =>
          p.id === currentPlayer.id ? updatedPlayer : p
        ),
      };
      addLog(
        s,
        `${currentPlayer.name} hand exceeded limit — auto-discarded ${discarded.name}.`
      );
      // Refresh reference
      currentPlayer = s.players.find((p) => p.id === originalPlayer.id)!;
    }
  }
  return s;
}

function getEffectiveFunction(card: Card): string {
  return card.chosenFunction ?? card.function;
}

/** True if the card natively offers `fn` as one of its possible functions (regardless of which slot it occupies). */
function cardHasFunctionNatively(card: Card, fn: string): boolean {
  if (card.function === fn) return true;
  if (card.alternateFunctions?.includes(fn)) return true;
  return false;
}

/** A card is a valid steal/target for the given function if it is currently placed there OR it natively supports that function. */
function cardMatchesStealFunction(card: Card, fn: string): boolean {
  return getEffectiveFunction(card) === fn || cardHasFunctionNatively(card, fn);
}

/** Returns every pile-slot function this card is allowed to occupy. */
function getCardValidFunctions(card: Card): string[] {
  return card.alternateFunctions ?? [card.function];
}

/** True if the card belongs to the given biological layer. */
function cardMatchesLayer(card: Card, layer: string): boolean {
  return card.layer === layer;
}

/** Returns all cards from a pile that belong to the given biological layer. */
function getCardsInLayer(pile: Card[], layer: string): Card[] {
  return pile.filter((c) => cardMatchesLayer(c, layer));
}

function getHasFunction(player: PlayerState, fn: string): boolean {
  return player.compostPile.some((c) => getEffectiveFunction(c) === fn);
}

function getCountFunction(player: PlayerState, fn: string): number {
  return player.compostPile.filter((c) => getEffectiveFunction(c) === fn).length;
}

function checkWinCondition(state: GameState): string | null {
  for (const player of state.players) {
    const won = WIN_FUNCTIONS.every((fn) => getHasFunction(player, fn));
    if (won) return player.id;
  }
  return null;
}

function recomputePlayerModifiers(
  state: GameState,
  player: PlayerState
): PlayerState {
  let maxHandSize = 5;
  let drawsExtraCard = false;

  // Old Timer hero: +1 hand size
  if (player.compostPile.some((c) => c.id === "old_timer")) {
    maxHandSize = 6;
  }

  // Dry Spell action modifier: if no Moisture in compost, max hand = 3
  const drySpell = state.activeModifiers.find((m) => m.cardId === "dry_spell");
  if (drySpell && !getHasFunction(player, "Moisture")) {
    maxHandSize = Math.min(maxHandSize, 3);
  }

  // Hot Pile Bonus: if 2+ Decomposers in compost, draw extra card per turn
  const hotPileBonus = state.activeModifiers.find(
    (m) => m.cardId === "hot_pile_bonus"
  );
  if (hotPileBonus && getCountFunction(player, "Decomposer") >= 2) {
    drawsExtraCard = true;
  }

  return { ...player, maxHandSize, drawsExtraCard };
}

function recomputeAllModifiers(state: GameState): GameState {
  const updatedPlayers = state.players.map((p) =>
    recomputePlayerModifiers(state, p)
  );
  return { ...state, players: updatedPlayers };
}

function playerHasProtection(
  state: GameState,
  player: PlayerState,
  actionCardId: string
): boolean {
  // Sir Stink-No-More protects against stinky_pile
  if (actionCardId === "stinky_pile") {
    if (player.compostPile.some((c) => c.id === "sir_stink_no_more")) return true;
    if (player.compostPile.some((c) => c.id === "stink_shield")) return true;
  }
  // Major Brown and Stink Shield protect against soggy_pile
  if (actionCardId === "soggy_pile") {
    if (player.compostPile.some((c) => c.id === "major_brown")) return true;
    if (player.compostPile.some((c) => c.id === "stink_shield")) return true;
  }
  // Soggy Saver: Moisture cards can't be removed from compost
  // (handled in soggy_pile resolution specifically)
  return false;
}

function moistureProtected(player: PlayerState): boolean {
  return player.compostPile.some((c) => c.id === "soggy_saver");
}

function triggerQuencher(s: GameState, playerId: string, card: Card): GameState {
  if (getEffectiveFunction(card) !== "Moisture") return s;
  const owner = getPlayer(s, playerId)!;
  if (!owner.compostPile.some((c) => c.id === "quencher")) return s;
  s = drawCard(s, getPlayer(s, playerId)!);
  addLog(s, `${owner.name} drew 1 card (The Quencher — Moisture card entered compost).`);
  return s;
}

function nextPlayerIndex(state: GameState): number {
  return (state.currentPlayerIndex + 1) % state.players.length;
}

// Apply the ongoing modifier to game state
function applyOngoingModifier(
  state: GameState,
  card: Card,
  playerId: string
): GameState {
  const modifier: ActiveModifier = {
    cardId: card.id,
    cardName: card.name,
    effect: card.cardText,
    appliedByPlayerId: playerId,
  };
  return {
    ...state,
    activeModifiers: [...state.activeModifiers, modifier],
  };
}

// ─────────────────────────────────────────────
// RESOLVE INSTANT HERO CARD EFFECTS
// ─────────────────────────────────────────────
function resolveHeroInstantEffect(
  state: GameState,
  player: PlayerState,
  card: Card
): GameState {
  let s = state;
  let p = player;

  switch (card.id) {
    // Fresh-Air Friend: discard 1 from hand to draw 2
    case "fresh_air_friend": {
      if (p.hand.length === 0) {
        addLog(s, `${p.name} has no cards in hand to discard for Fresh-Air Friend.`);
        return s;
      }
      // requires player to choose — set pending decision
      s = {
        ...s,
        pendingDecision: {
          type: "choose_card_from_hand",
          playerId: p.id,
          cardId: card.id,
          options: p.hand.map((c) => ({ cardId: c.id, cardName: c.name })),
          prompt: `${p.name}: Choose 1 card from your hand to discard. You will then draw 2 cards.`,
          meta: { drawAfter: 2 },
        },
      };
      return s;
    }

    // Branch Buddy: discard 1 from hand to draw 1
    case "branch_buddy": {
      if (p.hand.length === 0) {
        addLog(s, `${p.name} has no cards in hand to discard for Branch Buddy.`);
        return s;
      }
      s = {
        ...s,
        pendingDecision: {
          type: "choose_card_from_hand",
          playerId: p.id,
          cardId: card.id,
          options: p.hand.map((c) => ({ cardId: c.id, cardName: c.name })),
          prompt: `${p.name}: Choose 1 card from your hand to discard. You will then draw 1 card.`,
          meta: { drawAfter: 1 },
        },
      };
      return s;
    }

    // Wiggly Worker: draw 1 extra card
    case "wiggly_worker": {
      s = drawCard(s, p);
      p = getPlayer(s, p.id)!;
      addLog(s, `${p.name} drew 1 extra card (Wiggly Worker).`);
      return s;
    }

    // Biochar: search discard for Moisture card, add to hand
    case "biochar": {
      const moistureInDiscard = s.discardPile.filter(
        (c) => c.function === "Moisture"
      );
      if (moistureInDiscard.length === 0) {
        addLog(s, `No Moisture cards in discard pile for Biochar.`);
        return s;
      }
      s = {
        ...s,
        pendingDecision: {
          type: "choose_card_from_discard",
          playerId: p.id,
          cardId: card.id,
          options: moistureInDiscard.map((c) => ({
            cardId: c.id,
            cardName: c.name,
          })),
          prompt: `${p.name}: Choose 1 Moisture card from the discard pile to add to your hand.`,
        },
      };
      return s;
    }

    // Brown Rogue: take 1 Nitrogen from any player's compost pile
    case "brown_rogue": {
      const targets = s.players
        .filter((pl) => pl.id !== p.id && pl.compostPile.some((c) => cardMatchesStealFunction(c, "Nitrogen")))
        .map((pl) => ({
          playerId: pl.id,
          playerName: pl.name,
          cards: pl.compostPile
            .filter((c) => cardMatchesStealFunction(c, "Nitrogen"))
            .map((c) => ({ cardId: c.id, cardName: c.name })),
        }));
      if (targets.length === 0) {
        addLog(s, `No opponents have Nitrogen cards in their compost pile.`);
        return s;
      }
      s = {
        ...s,
        pendingDecision: {
          type: "choose_opponent_for_steal",
          playerId: p.id,
          cardId: card.id,
          options: targets,
          prompt: `${p.name}: Choose a Nitrogen card to take from an opponent's compost pile.`,
          meta: { stealFunction: "Nitrogen" },
        },
      };
      return s;
    }

    // Mycelial Alchemist: all players discard 1 Decomposer from compost
    case "mycelial_alchemist": {
      addLog(s, `Mycelial Alchemist: All players discard 1 Decomposer from compost.`);
      for (const pl of s.players) {
        const decomposerIdx = pl.compostPile.findIndex(
          (c) => c.function === "Decomposer"
        );
        if (decomposerIdx >= 0) {
          const discarded = pl.compostPile[decomposerIdx];
          const updatedPlayer = {
            ...pl,
            compostPile: pl.compostPile.filter((_, i) => i !== decomposerIdx),
          };
          s = {
            ...s,
            discardPile: [discarded, ...s.discardPile],
          };
          s = updatePlayer(s, updatedPlayer);
          addLog(s, `${pl.name} discarded ${discarded.name} from compost.`);
        }
      }
      return s;
    }

    // The Under-Web: swap 1 card from hand with 1 from discard
    case "under_web": {
      if (p.hand.length === 0) {
        addLog(s, `${p.name} has no cards in hand for The Under-Web.`);
        return s;
      }
      if (s.discardPile.length === 0) {
        addLog(s, `Discard pile is empty for The Under-Web.`);
        return s;
      }
      s = {
        ...s,
        pendingDecision: {
          type: "choose_under_web_hand_card",
          playerId: p.id,
          cardId: card.id,
          options: p.hand.map((c) => ({ cardId: c.id, cardName: c.name })),
          prompt: `${p.name}: Choose 1 card from your hand to swap with a card from the discard pile.`,
        },
      };
      return s;
    }

    // Actinomycetes: choose Hero from discard, play immediately to compost
    case "actinomycetes": {
      const heroesInDiscard = s.discardPile.filter((c) => c.type === "hero");
      if (heroesInDiscard.length === 0) {
        addLog(s, `No Hero cards in discard pile for Actinomycetes.`);
        return s;
      }
      // Check Plastic Contamination
      const plasticMod = s.activeModifiers.find(
        (m) => m.cardId === "plastic_contamination"
      );
      if (plasticMod) {
        addLog(s, `Plastic Contamination prevents playing hero cards to compost pile!`);
        return s;
      }
      s = {
        ...s,
        pendingDecision: {
          type: "choose_hero_from_discard",
          playerId: p.id,
          cardId: card.id,
          options: heroesInDiscard.map((c) => ({
            cardId: c.id,
            cardName: c.name,
            cardFunction: c.function,
          })),
          prompt: `${p.name}: Choose 1 Hero card from the discard pile to add to your compost pile.`,
        },
      };
      return s;
    }

    // The Catalyst: if 2+ Decomposers in compost, take another turn
    case "catalyst": {
      const decomposerCount = getCountFunction(p, "Decomposer");
      if (decomposerCount >= 2) {
        s = { ...s, extraTurn: true };
        addLog(s, `${p.name} has 2 Decomposers — The Catalyst grants another turn!`);
      } else {
        addLog(
          s,
          `${p.name} needs 2 Decomposers in compost for The Catalyst (has ${decomposerCount}).`
        );
      }
      return s;
    }

    // Captain Nectar: skip next player's turn
    case "captain_nectar": {
      const nextIdx = nextPlayerIndex(s);
      const nextPlayer = s.players[nextIdx];
      const updatedNext = { ...nextPlayer, skipsNextTurn: true };
      s = updatePlayer(s, updatedNext);
      addLog(s, `${nextPlayer.name} will skip their next turn (Captain Nectar).`);
      return s;
    }

    // The Hydro-Hauler: all players draw 1
    case "hydro_hauler": {
      for (const pl of s.players) {
        s = drawCard(s, getPlayer(s, pl.id)!);
        addLog(s, `${pl.name} drew 1 card (Hydro-Hauler).`);
      }
      return s;
    }

    // The Slumber-Soaker: if has 1 Decomposer in compost, draw 1
    case "slumber_soaker": {
      if (getCountFunction(p, "Decomposer") >= 1) {
        s = drawCard(s, p);
        addLog(s, `${p.name} drew 1 card (Slumber-Soaker — has Decomposer).`);
      } else {
        addLog(s, `${p.name} has no Decomposer in compost — Slumber-Soaker had no effect.`);
      }
      return s;
    }

    // The Microbial Marshal: if first card in compost, draw 2
    case "microbial_marshal": {
      // card just added to compost (length is 1 after adding)
      if (p.compostPile.length === 1) {
        s = drawCard(s, p, 2);
        addLog(s, `${p.name} drew 2 cards (Microbial Marshal — first compost card!).`);
      } else {
        addLog(s, `${p.name} already has cards in compost — Microbial Marshal had no effect.`);
      }
      return s;
    }

    // The Brown Bomber: if has 1 Carbon in compost, draw 1
    case "brown_bomber": {
      if (getCountFunction(p, "Carbon") >= 1) {
        s = drawCard(s, p);
        addLog(s, `${p.name} drew 1 card (Brown Bomber — has Carbon).`);
      } else {
        addLog(s, `${p.name} has no Carbon in compost — Brown Bomber had no effect.`);
      }
      return s;
    }

    // The Anaerobic Tyrant: if has 1 Decomposer or 1 Carbon in compost, draw 1
    case "anaerobic_tyrant": {
      if (getCountFunction(p, "Decomposer") >= 1 || getCountFunction(p, "Carbon") >= 1) {
        s = drawCard(s, p);
        addLog(s, `${p.name} drew 1 card (Anaerobic Tyrant).`);
      } else {
        addLog(s, `${p.name} needs Decomposer or Carbon — Anaerobic Tyrant had no effect.`);
      }
      return s;
    }

    // The Legion of Life: discard the active Ongoing Action Card
    case "legion_of_life": {
      // Prioritize Plastic Contamination; otherwise target the current ongoingActionCard
      const plasticMod = s.activeModifiers.find((m) => m.cardId === "plastic_contamination");
      const ongoingActions = s.activeModifiers.filter(
        (m) => getAllCards().find((c) => c.id === m.cardId)?.type === "action"
      );
      const toRemoveMod = plasticMod ?? ongoingActions[0];
      if (!toRemoveMod) {
        addLog(s, `No active Ongoing Action Card to discard (Legion of Life).`);
        return s;
      }
      // Find the card and move to discard
      const removedCard = getAllCards().find((c) => c.id === toRemoveMod.cardId);
      if (removedCard) {
        s = {
          ...s,
          discardPile: [removedCard, ...s.discardPile],
          activeModifiers: s.activeModifiers.filter(
            (m) => m.cardId !== toRemoveMod.cardId
          ),
          ongoingActionCard:
            s.ongoingActionCard?.id === toRemoveMod.cardId
              ? null
              : s.ongoingActionCard,
        };
        addLog(s, `${p.name} used Legion of Life to remove ${removedCard.name}.`);
      }
      return s;
    }

    // The Breezy Bandit: swap 1 card from another player's compost with yours (3-step)
    case "breezy_bandit": {
      const validOpponents = s.players
        .filter((pl) => pl.id !== p.id)
        .filter((pl) => {
          const swappable = pl.compostPile.filter(
            (c) => !(moistureProtected(pl) && getEffectiveFunction(c) === "Moisture")
          );
          return swappable.length > 0;
        })
        .map((pl) => ({ playerId: pl.id, playerName: pl.name }));
      if (validOpponents.length === 0 || p.compostPile.length === 0) {
        addLog(s, `Cannot use Breezy Bandit — no valid targets or your compost is empty.`);
        return s;
      }
      s = {
        ...s,
        pendingDecision: {
          type: "choose_swap_opponent_breezy",
          playerId: p.id,
          cardId: card.id,
          options: validOpponents,
          prompt: `${p.name}: Choose an opponent to swap a compost card with (Breezy Bandit).`,
        },
      };
      return s;
    }

    default:
      addLog(s, `${p.name} played ${card.name} (effect applied).`);
      return s;
  }
}

// Helper: apply the worm party pass using a specific card for the active player
// chosenCardId = null means the active player has no hand (skip them)
function applyWormParty(state: GameState, activePlayerId: string, chosenCardId: string | null): GameState {
  let s = state;
  const passCards: Array<{ fromId: string; card: Card }> = [];

  for (const pl of s.players) {
    if (pl.id === activePlayerId) {
      if (chosenCardId) {
        const card = pl.hand.find((c) => c.id === chosenCardId);
        if (card) passCards.push({ fromId: pl.id, card });
      }
    } else if (pl.hand.length > 0) {
      passCards.push({ fromId: pl.id, card: pl.hand[0] });
    }
  }

  // Remove cards from hands
  for (const { fromId, card: passedCard } of passCards) {
    const pl = getPlayer(s, fromId)!;
    s = updatePlayer(s, { ...pl, hand: pl.hand.filter((c) => c.id !== passedCard.id) });
  }

  // Give cards to the player on the left (i+1)
  for (let i = 0; i < s.players.length; i++) {
    const passEntry = passCards.find((pc) => pc.fromId === s.players[i].id);
    if (passEntry) {
      const leftIdx = (i + 1) % s.players.length;
      const leftPlayer = s.players[leftIdx];
      s = updatePlayer(s, { ...leftPlayer, hand: [...leftPlayer.hand, passEntry.card] });
    }
  }

  const names = passCards.map((pc) => {
    const pl = state.players.find((p) => p.id === pc.fromId)!;
    return `${pl.name} → ${pc.card.name}`;
  });
  addLog(s, `Worm Party — cards passed: ${names.join(", ")}.`);
  return s;
}

// ─────────────────────────────────────────────
// RESOLVE INSTANT ACTION CARD EFFECTS
// ─────────────────────────────────────────────
function resolveActionInstantEffect(
  state: GameState,
  player: PlayerState,
  card: Card
): GameState {
  let s = state;
  const p = player;

  switch (card.id) {
    // Anaerobic Pocket: discard 1 Airflow from compost, then choose opponent to skip
    case "anaerobic_pocket": {
      const airflowCards = p.compostPile.filter((c) => c.function === "Airflow");
      if (airflowCards.length === 0) {
        addLog(s, `${p.name} has no Airflow cards in compost to discard for Anaerobic Pocket.`);
        return s;
      }
      s = {
        ...s,
        pendingDecision: {
          type: "choose_card_from_compost",
          playerId: p.id,
          cardId: card.id,
          options: airflowCards.map((c) => ({ cardId: c.id, cardName: c.name })),
          prompt: `${p.name}: Choose 1 Airflow card from your compost pile to discard (Anaerobic Pocket).`,
          meta: { nextStep: "choose_target_player" },
        },
      };
      return s;
    }

    // Carbon Sink: if 2+ Carbon, take 1 Nitrogen from opponent's compost
    case "carbon_sink": {
      if (getCountFunction(p, "Carbon") < 2) {
        addLog(s, `${p.name} needs 2 Carbon cards in compost for Carbon Sink.`);
        return s;
      }
      const targets = s.players
        .filter((pl) => pl.id !== p.id && pl.compostPile.some((c) => c.function === "Nitrogen"))
        .map((pl) => ({
          playerId: pl.id,
          playerName: pl.name,
          cards: pl.compostPile
            .filter((c) => c.function === "Nitrogen")
            .map((c) => ({ cardId: c.id, cardName: c.name })),
        }));
      if (targets.length === 0) {
        addLog(s, `No opponents have Nitrogen cards for Carbon Sink.`);
        return s;
      }
      s = {
        ...s,
        pendingDecision: {
          type: "choose_opponent_for_steal",
          playerId: p.id,
          cardId: card.id,
          options: targets,
          prompt: `${p.name}: Choose a Nitrogen card to steal from an opponent's compost pile (Carbon Sink).`,
          meta: { stealToCompost: true, stealFunction: "Nitrogen" },
        },
      };
      return s;
    }

    // Critter Raid: all players (including active player) discard 1 Nitrogen from hand
    case "critter_raid": {
      addLog(s, `Critter Raid! All players must discard 1 Nitrogen card from hand.`);
      for (const pl of s.players) {
        const currentPl = getPlayer(s, pl.id)!;
        const nitrogenIdx = currentPl.hand.findIndex((c) => getEffectiveFunction(c) === "Nitrogen");
        if (nitrogenIdx >= 0) {
          const discarded = currentPl.hand[nitrogenIdx];
          s = {
            ...s,
            discardPile: [discarded, ...s.discardPile],
          };
          s = updatePlayer(s, {
            ...currentPl,
            hand: currentPl.hand.filter((_, i) => i !== nitrogenIdx),
          });
          addLog(s, `${pl.name} discarded ${discarded.name}.`);
        }
      }
      return s;
    }

    // High Heat Gamble: draw 3 cards, if none are Decomposers, skip next turn
    case "high_heat_gamble": {
      const handBefore = getPlayer(s, p.id)!.hand.length;
      s = drawCard(s, getPlayer(s, p.id)!, 3);
      const handAfter = getPlayer(s, p.id)!.hand;
      const newCards = handAfter.slice(handBefore);
      const hasDecomposer = newCards.some((c) => c.function === "Decomposer");
      if (!hasDecomposer) {
        const updatedP = { ...getPlayer(s, p.id)!, skipsNextTurn: true };
        s = updatePlayer(s, updatedP);
        addLog(s, `${p.name} drew no Decomposers — skips next turn (High Heat Gamble)!`);
      } else {
        addLog(s, `${p.name} drew a Decomposer — High Heat Gamble pays off!`);
      }
      return s;
    }

    // Rainstorm: draw 2, any Moisture/Nitrogen may be played to compost immediately
    case "rainstorm": {
      const handBefore = getPlayer(s, p.id)!.hand.length;
      s = drawCard(s, getPlayer(s, p.id)!, 2);
      const currentPlayer = getPlayer(s, p.id)!;
      const newCards = currentPlayer.hand.slice(handBefore);
      const eligible = newCards.filter(
        (c) => c.function === "Moisture" || c.function === "Nitrogen"
      );
      if (eligible.length > 0) {
        s = {
          ...s,
          pendingDecision: {
            type: "choose_rainstorm_play",
            playerId: p.id,
            cardId: card.id,
            options: eligible.map((c) => ({ cardId: c.id, cardName: c.name })),
            prompt: `${p.name}: Rainstorm — you may play any Moisture or Nitrogen cards drawn into your compost pile. Choose cards to play (or none).`,
            meta: { optional: true },
          },
        };
      } else {
        addLog(s, `${p.name} drew 2 cards (Rainstorm) — no Moisture/Nitrogen to play.`);
      }
      return s;
    }

    // Soggy Pile: each player discards 1 Moisture or Nitrogen from compost
    case "soggy_pile": {
      addLog(s, `Soggy Pile! Each player must discard 1 Moisture or Nitrogen from compost.`);
      for (const pl of s.players) {
        if (playerHasProtection(s, pl, "soggy_pile")) {
          addLog(s, `${pl.name} is protected from Soggy Pile!`);
          continue;
        }
        const candidates = pl.compostPile.filter((c) => {
          if (c.function === "Moisture" && moistureProtected(pl)) return false;
          return c.function === "Moisture" || c.function === "Nitrogen";
        });
        if (candidates.length > 0) {
          // Auto discard first eligible
          const toDiscard = candidates[0];
          const updated = {
            ...pl,
            compostPile: pl.compostPile.filter((c) => c.id !== toDiscard.id),
          };
          s = {
            ...s,
            discardPile: [toDiscard, ...s.discardPile],
          };
          s = updatePlayer(s, updated);
          addLog(s, `${pl.name} discarded ${toDiscard.name} from compost.`);
        }
      }
      return s;
    }

    // Spread Nutrients: give 1 card to each player, draw same number back
    case "spread_nutrients": {
      const others = s.players.filter((pl) => pl.id !== p.id);
      if (others.length === 0 || getPlayer(s, p.id)!.hand.length < others.length) {
        addLog(s, `${p.name} doesn't have enough cards to spread (needs ${others.length}).`);
        return s;
      }
      s = {
        ...s,
        pendingDecision: {
          type: "choose_discard_for_spread",
          playerId: p.id,
          cardId: card.id,
          options: getPlayer(s, p.id)!.hand.map((c) => ({
            cardId: c.id,
            cardName: c.name,
          })),
          prompt: `${p.name}: Choose ${others.length} card(s) to give to other players (one each, Spread Nutrients).`,
          meta: { count: others.length, othersIds: others.map((pl) => pl.id) },
        },
      };
      return s;
    }

    // Stinky Pile: each player discards 1 Nitrogen from compost (includes the active player)
    case "stinky_pile": {
      addLog(s, `Stinky Pile! Each player discards 1 Nitrogen from their compost.`);
      for (const pl of s.players) {
        if (playerHasProtection(s, pl, "stinky_pile")) {
          addLog(s, `${pl.name} is protected from Stinky Pile!`);
          continue;
        }
        const nitrogenIdx = pl.compostPile.findIndex(
          (c) => getEffectiveFunction(c) === "Nitrogen"
        );
        if (nitrogenIdx >= 0) {
          const currentPl = getPlayer(s, pl.id)!;
          const discarded = currentPl.compostPile[nitrogenIdx];
          s = {
            ...s,
            discardPile: [discarded, ...s.discardPile],
          };
          s = updatePlayer(s, {
            ...currentPl,
            compostPile: currentPl.compostPile.filter((_, i) => i !== nitrogenIdx),
          });
          addLog(s, `${pl.name} discarded ${discarded.name} from compost.`);
        }
      }
      return s;
    }

    // Time Warp: take another full turn
    case "time_warp": {
      s = { ...s, extraTurn: true };
      addLog(s, `${p.name} plays Time Warp — takes another turn!`);
      return s;
    }

    // Worm Party: each player passes 1 card from hand to player on left
    // Prompt the active player to choose; auto-pick hand[0] for others
    case "worm_party": {
      if (p.hand.length === 0) {
        addLog(s, `Worm Party — ${p.name} has no cards to pass, skipping their pass.`);
        // Auto-process for all other players
        s = applyWormParty(s, p.id, null);
        return s;
      }
      s = {
        ...s,
        pendingDecision: {
          type: "choose_worm_party_card",
          playerId: p.id,
          cardId: card.id,
          options: p.hand.map((c) => ({ cardId: c.id, cardName: c.name })),
          prompt: `${p.name}: Choose 1 card from your hand to pass to the player on your left (Worm Party).`,
        },
      };
      return s;
    }

    // Pile Flip: all players pass their entire compost pile to the left
    // Soggy Saver owners keep their own Moisture cards; only non-Moisture cards are passed
    case "pile_flip": {
      const n = s.players.length;
      const pilesToPass = s.players.map((pl) =>
        moistureProtected(pl)
          ? pl.compostPile.filter((c) => getEffectiveFunction(c) !== "Moisture")
          : pl.compostPile
      );
      const keptMoisture = s.players.map((pl) =>
        moistureProtected(pl)
          ? pl.compostPile.filter((c) => getEffectiveFunction(c) === "Moisture")
          : []
      );
      let newState = { ...s };
      for (let i = 0; i < n; i++) {
        const pl = newState.players[i];
        const receivedPile = pilesToPass[(i + n - 1) % n];
        const updated = { ...pl, compostPile: [...keptMoisture[i], ...receivedPile] };
        newState = updatePlayer(newState, updated);
      }
      s = newState;
      addLog(s, `Pile Flip — all compost piles passed to the left!`);
      return s;
    }

    // Rot Roulette: draw 5, discard 3, keep 2, play 1 immediately
    case "rot_roulette": {
      const handBefore = getPlayer(s, p.id)!.hand.length;
      s = drawCard(s, getPlayer(s, p.id)!, 5);
      const handAfter = getPlayer(s, p.id)!.hand;
      const drawnCards = handAfter.slice(handBefore);
      if (drawnCards.length < 5) {
        addLog(s, `${p.name} drew ${drawnCards.length} cards (deck limited) for Rot Roulette.`);
      }
      s = {
        ...s,
        pendingDecision: {
          type: "choose_rot_roulette_keep",
          playerId: p.id,
          cardId: card.id,
          options: drawnCards.map((c) => ({ cardId: c.id, cardName: c.name })),
          prompt: `${p.name}: Rot Roulette — choose 2 cards to keep (discard rest). Then you must play 1 of them.`,
          meta: { keepCount: 2, drawnCardIds: drawnCards.map((c) => c.id) },
        },
      };
      return s;
    }

    default:
      addLog(s, `${p.name} played ${card.name}.`);
      return s;
  }
}

// ─────────────────────────────────────────────
// PLAY A CARD (from hand)
// ─────────────────────────────────────────────
export function playCard(
  state: GameState,
  playerId: string,
  cardId: string
): { state: GameState; error?: string } {
  const player = getPlayer(state, playerId);
  if (!player) return { state, error: "Player not found" };

  const cardInHand = player.hand.find((c) => c.id === cardId);
  if (!cardInHand) return { state, error: "Card not in hand" };

  if (state.pendingDecision) {
    return { state, error: "Must resolve pending decision first" };
  }

  // Check Plastic Contamination for hero cards
  // Exception: Legion of Life can always be played — its effect removes the ongoing action card
  if (cardInHand.type === "hero" && cardInHand.id !== "legion_of_life") {
    const plasticMod = state.activeModifiers.find(
      (m) => m.cardId === "plastic_contamination"
    );
    if (plasticMod) {
      return {
        state,
        error: "Plastic Contamination is active — no hero cards can be added to compost!",
      };
    }
    // Block hero if an action card was already played this turn (action must follow hero, not precede)
    if (state.actionPlayedThisTurn && !state.heroPlayedThisTurn) {
      return {
        state,
        error: "You already played an action card — heroes must be played before actions.",
      };
    }
    // Enforce 1 hero card per turn
    if (state.heroPlayedThisTurn) {
      return {
        state,
        error: "You can only play one hero card per turn.",
      };
    }
  }

  // Remove card from hand
  let updatedPlayer = {
    ...player,
    hand: player.hand.filter((c) => c.id !== cardId),
  };
  let s = updatePlayer(state, updatedPlayer);

  if (cardInHand.type === "hero") {
    // Mark hero as played this turn
    s = { ...s, heroPlayedThisTurn: true };

    // If card has multiple possible functions, ask player to choose which slot
    const allFunctions = cardInHand.alternateFunctions?.length
      ? [...new Set([cardInHand.function, ...cardInHand.alternateFunctions])]
      : [];
    if (allFunctions.length > 1) {
      addLog(s, `${player.name} played ${cardInHand.name} — choose which function slot to fill.`);
      s = {
        ...s,
        pendingDecision: {
          type: "choose_function",
          playerId: player.id,
          cardId: cardInHand.id,
          prompt: `${player.name}: Choose which function slot to fill with ${cardInHand.name}.`,
          options: allFunctions.map((fn) => ({ function: fn })),
          meta: { pendingCard: cardInHand as unknown as Record<string, unknown> },
        },
      };
      s = updatePlayer(s, updatedPlayer);
      return { state: s };
    }

    // Add to compost pile
    updatedPlayer = {
      ...updatedPlayer,
      compostPile: [...updatedPlayer.compostPile, cardInHand],
    };
    s = updatePlayer(s, updatedPlayer);
    addLog(s, `${player.name} played ${cardInHand.name} into their compost pile.`);

    if (cardInHand.effectType === "ongoing") {
      // Ongoing hero effects are passive (checked on demand)
      // Apply ongoing modifiers for hand size / draw
      s = recomputeAllModifiers(s);
      addLog(s, `${cardInHand.name} ongoing effect is now active for ${player.name}.`);
    } else {
      // Instant hero effect
      s = resolveHeroInstantEffect(s, getPlayer(s, player.id)!, cardInHand);
    }
    // Quencher: whenever a Moisture card enters compost, draw 1 extra card
    s = triggerQuencher(s, player.id, cardInHand);
  } else {
    // Action card — limit to 1 action card per turn (regardless of whether a hero was played)
    if (state.actionPlayedThisTurn) {
      // Undo the hand removal before returning the error
      s = updatePlayer(state, player);
      return { state: s, error: "You may only play one action card per turn." };
    }
    if (cardInHand.effectType === "ongoing") {
      // Move old ongoing action card to discard if one was active
      const prevOngoing = s.ongoingActionCard;
      s = applyOngoingModifier(s, cardInHand, player.id);
      s = {
        ...s,
        ongoingActionCard: cardInHand,
        activeModifiers: prevOngoing
          ? s.activeModifiers.filter((m) => m.cardId !== prevOngoing.id)
          : s.activeModifiers,
        discardPile: prevOngoing ? [prevOngoing, ...s.discardPile] : s.discardPile,
      };
      s = recomputeAllModifiers(s);
      addLog(s, `${player.name} played ${cardInHand.name} (ongoing effect now active).`);
    } else {
      // Instant action
      s = {
        ...s,
        discardPile: [cardInHand, ...s.discardPile],
      };
      s = resolveActionInstantEffect(s, getPlayer(s, player.id)!, cardInHand);
    }
    // Track that an action card was played this turn
    s = { ...s, actionPlayedThisTurn: true };
  }

  // Check Hot Head hero: each time a Carbon card is discarded, draw 1
  // (check if the played card itself was discarded as a Carbon card)
  // This is for ongoing Hot Head passive — not triggered here directly

  // Check win condition
  const winner = checkWinCondition(s);
  if (winner) {
    s = { ...s, winner, phase: "game_over" };
    const winnerPlayer = getPlayer(s, winner)!;
    addLog(s, `🎉 ${winnerPlayer.name} wins! They collected one hero from each function!`);
  }

  return { state: s };
}

// ─────────────────────────────────────────────
// RESOLVE DECISION
// ─────────────────────────────────────────────
export function resolveDecision(
  state: GameState,
  playerId: string,
  decisionData: Record<string, unknown>
): { state: GameState; error?: string } {
  const decision = state.pendingDecision;
  if (!decision) return { state, error: "No pending decision" };
  if (decision.playerId !== playerId)
    return { state, error: "Not your decision to make" };

  let s = { ...state, pendingDecision: null };
  const player = getPlayer(s, playerId)!;

  switch (decision.type) {
    // Player discards a card from hand, then draws
    case "choose_card_from_hand": {
      const chosenCardId = decisionData.cardId as string;
      const card = player.hand.find((c) => c.id === chosenCardId);
      if (!card) return { state, error: "Card not in hand" };

      // Special case: Rot Roulette play — play card as if playing from hand
      // Bypass heroPlayedThisTurn restriction since Rot Roulette forces this play
      if (decision.meta?.rotRoulettePlay) {
        s = { ...s, pendingDecision: null, heroPlayedThisTurn: false, actionPlayedThisTurn: false };
        const playResult = playCard(s, playerId, chosenCardId);
        return playResult;
      }

      const updatedPlayer = {
        ...player,
        hand: player.hand.filter((c) => c.id !== chosenCardId),
      };
      s = {
        ...s,
        discardPile: [card, ...s.discardPile],
      };
      s = updatePlayer(s, updatedPlayer);
      addLog(s, `${player.name} discarded ${card.name} from hand.`);

      // Check Hot Head hero effect for Carbon discards (only for the player who discarded)
      if (card.function === "Carbon") {
        const hotHeadOwner = getPlayer(s, playerId)!;
        if (hotHeadOwner.compostPile.some((c) => c.id === "hot_head")) {
          s = drawCard(s, getPlayer(s, playerId)!);
          addLog(s, `${hotHeadOwner.name} drew 1 card (The Hot Head — Carbon discarded).`);
        }
      }

      const drawCount = (decision.meta?.drawAfter as number) ?? 1;
      s = drawCard(s, getPlayer(s, playerId)!, drawCount);
      addLog(s, `${player.name} drew ${drawCount} card(s).`);
      return { state: s };
    }

    case "choose_card_from_discard": {
      const chosenCardId = decisionData.cardId as string;
      const card = s.discardPile.find((c) => c.id === chosenCardId);
      if (!card) return { state, error: "Card not found in discard" };

      const updatedPlayer = {
        ...player,
        hand: [...player.hand, card],
      };
      s = {
        ...s,
        discardPile: s.discardPile.filter((c) => c.id !== chosenCardId),
      };
      s = updatePlayer(s, updatedPlayer);
      addLog(s, `${player.name} took ${card.name} from discard pile into hand.`);
      return { state: s };
    }

    case "choose_card_from_compost": {
      // Anaerobic Pocket: discard Airflow card, then choose target
      const chosenCardId = decisionData.cardId as string;
      const card = player.compostPile.find((c) => c.id === chosenCardId);
      if (!card) return { state, error: "Card not in compost" };

      const updatedPlayer = {
        ...player,
        compostPile: player.compostPile.filter((c) => c.id !== chosenCardId),
      };
      s = {
        ...s,
        discardPile: [card, ...s.discardPile],
      };
      s = updatePlayer(s, updatedPlayer);
      addLog(s, `${player.name} discarded ${card.name} from compost.`);

      // Now need to pick target player to skip
      const opponents = s.players.filter((pl) => pl.id !== playerId);
      if (opponents.length > 0) {
        s = {
          ...s,
          pendingDecision: {
            type: "choose_target_player",
            playerId,
            cardId: decision.cardId,
            options: opponents.map((pl) => ({
              playerId: pl.id,
              playerName: pl.name,
            })),
            prompt: `${player.name}: Choose an opponent to skip their next turn (Anaerobic Pocket).`,
          },
        };
      }
      return { state: s };
    }

    case "choose_target_player": {
      const targetId = decisionData.targetPlayerId as string;
      const targetPlayer = getPlayer(s, targetId);
      if (!targetPlayer) return { state, error: "Target player not found" };

      const updated = { ...targetPlayer, skipsNextTurn: true };
      s = updatePlayer(s, updated);
      addLog(s, `${targetPlayer.name} will skip their next turn!`);
      return { state: s };
    }

    case "choose_opponent_for_steal": {
      const targetPlayerId = decisionData.targetPlayerId as string;
      const targetPlayer = getPlayer(s, targetPlayerId);
      if (!targetPlayer) return { state, error: "Target player not found" };

      const stealFunction = decision.meta?.stealFunction as string | undefined;
      const validCards = targetPlayer.compostPile.filter(
        (c) => !stealFunction || cardMatchesStealFunction(c, stealFunction)
      );
      if (validCards.length === 0) return { state, error: "No valid cards to steal from this player" };

      if (validCards.length === 1) {
        // Auto-steal the only card
        const card = validCards[0];
        const updatedTarget = {
          ...targetPlayer,
          compostPile: targetPlayer.compostPile.filter((c) => c.id !== card.id),
        };
        s = updatePlayer(s, updatedTarget);
        const stealToCompost = decision.meta?.stealToCompost as boolean;
        if (stealToCompost) {
          s = updatePlayer(s, {
            ...getPlayer(s, playerId)!,
            compostPile: [...getPlayer(s, playerId)!.compostPile, card],
          });
          addLog(s, `${player.name} took ${card.name} from ${targetPlayer.name}'s compost into their own compost.`);
        } else {
          s = updatePlayer(s, {
            ...getPlayer(s, playerId)!,
            hand: [...getPlayer(s, playerId)!.hand, card],
          });
          addLog(s, `${player.name} took ${card.name} from ${targetPlayer.name}'s compost into hand.`);
        }
        return { state: s };
      }

      // Multiple cards — let the player pick one
      s = {
        ...s,
        pendingDecision: {
          type: "choose_steal_card",
          playerId,
          cardId: decision.cardId,
          options: validCards.map((c) => ({ cardId: c.id, cardName: c.name })),
          prompt: `Choose which card to steal from ${targetPlayer.name}'s compost pile.`,
          meta: { ...decision.meta, targetPlayerId },
        },
      };
      return { state: s };
    }

    case "choose_steal_card": {
      const chosenCardId = decisionData.cardId as string;
      const targetPlayerId = decision.meta?.targetPlayerId as string;
      const targetPlayer = getPlayer(s, targetPlayerId);
      if (!targetPlayer) return { state, error: "Target player not found" };

      const card = targetPlayer.compostPile.find((c) => c.id === chosenCardId);
      if (!card) return { state, error: "Card not in target's compost" };

      s = updatePlayer(s, {
        ...targetPlayer,
        compostPile: targetPlayer.compostPile.filter((c) => c.id !== chosenCardId),
      });
      const stealToCompost = decision.meta?.stealToCompost as boolean;
      if (stealToCompost) {
        s = updatePlayer(s, {
          ...getPlayer(s, playerId)!,
          compostPile: [...getPlayer(s, playerId)!.compostPile, card],
        });
        addLog(s, `${player.name} took ${card.name} from ${targetPlayer.name}'s compost into their own compost.`);
      } else {
        s = updatePlayer(s, {
          ...getPlayer(s, playerId)!,
          hand: [...getPlayer(s, playerId)!.hand, card],
        });
        addLog(s, `${player.name} took ${card.name} from ${targetPlayer.name}'s compost into hand.`);
      }
      return { state: s };
    }

    case "choose_swap_opponent_breezy": {
      const targetPlayerId = decisionData.targetPlayerId as string;
      const targetPlayer = getPlayer(s, targetPlayerId);
      if (!targetPlayer) return { state, error: "Opponent not found" };
      const swappable = targetPlayer.compostPile.filter(
        (c) => !(moistureProtected(targetPlayer) && getEffectiveFunction(c) === "Moisture")
      );
      if (swappable.length === 0) return { state, error: "No swappable cards in that player's pile" };
      s = {
        ...s,
        pendingDecision: {
          type: "choose_swap_their_card_breezy",
          playerId,
          cardId: decision.cardId,
          options: swappable.map((c) => ({ cardId: c.id, cardName: c.name })),
          prompt: `Choose which of ${targetPlayer.name}'s compost cards to take.`,
          meta: { theirPlayerId: targetPlayerId },
        },
      };
      return { state: s };
    }

    case "choose_swap_their_card_breezy": {
      const theirCardId = decisionData.cardId as string;
      const theirPlayerId = decision.meta?.theirPlayerId as string;
      const theirPlayer = getPlayer(s, theirPlayerId);
      if (!theirPlayer) return { state, error: "Opponent not found" };
      const theirCard = theirPlayer.compostPile.find((c) => c.id === theirCardId);
      if (!theirCard) return { state, error: "Card not found in opponent's pile" };
      if (player.compostPile.length === 0) return { state, error: "Your compost pile is empty — nothing to swap." };
      s = {
        ...s,
        pendingDecision: {
          type: "choose_swap_my_card_breezy",
          playerId,
          cardId: decision.cardId,
          options: player.compostPile.map((c) => ({ cardId: c.id, cardName: c.name })),
          prompt: `Choose which of your compost cards to give to ${theirPlayer.name} in exchange.`,
          meta: { theirPlayerId, theirCardId },
        },
      };
      return { state: s };
    }

    case "choose_swap_my_card_breezy": {
      const myCardId = decisionData.cardId as string;
      const theirCardId = decision.meta?.theirCardId as string;
      const theirPlayerId = decision.meta?.theirPlayerId as string;
      const myCard = player.compostPile.find((c) => c.id === myCardId);
      const theirPlayer = getPlayer(s, theirPlayerId);
      if (!myCard || !theirPlayer) return { state, error: "Invalid swap cards" };
      const theirCard = theirPlayer.compostPile.find((c) => c.id === theirCardId);
      if (!theirCard) return { state, error: "Their card not found" };
      if (moistureProtected(theirPlayer) && getEffectiveFunction(theirCard) === "Moisture") {
        return { state, error: `${theirPlayer.name}'s Moisture cards are protected by the Soggy Saver!` };
      }
      s = updatePlayer(s, {
        ...player,
        compostPile: [...player.compostPile.filter((c) => c.id !== myCardId), theirCard],
      });
      s = updatePlayer(s, {
        ...theirPlayer,
        compostPile: [...theirPlayer.compostPile.filter((c) => c.id !== theirCardId), myCard],
      });
      addLog(s, `${player.name} swapped ${myCard.name} with ${theirPlayer.name}'s ${theirCard.name}.`);
      return { state: s };
    }

    case "choose_worm_party_card": {
      const chosenId = decisionData.cardId as string;
      const myCard = player.hand.find((c) => c.id === chosenId);
      if (!myCard) return { state, error: "Card not in hand" };
      s = applyWormParty(s, playerId, chosenId);
      return { state: s };
    }

    case "choose_hero_from_discard": {
      const chosenCardId = decisionData.cardId as string;
      const card = s.discardPile.find(
        (c) => c.id === chosenCardId && c.type === "hero"
      );
      if (!card) return { state, error: "Hero not found in discard" };

      const plasticMod = s.activeModifiers.find(
        (m) => m.cardId === "plastic_contamination"
      );
      if (plasticMod) {
        return { state, error: "Plastic Contamination blocks hero placement" };
      }

      const updatedPlayer = {
        ...player,
        compostPile: [...player.compostPile, card],
      };
      s = {
        ...s,
        discardPile: s.discardPile.filter((c) => c.id !== chosenCardId),
      };
      s = updatePlayer(s, updatedPlayer);
      addLog(s, `${player.name} placed ${card.name} from discard into compost (Actinomycetes).`);

      // Resolve the placed card's ongoing/instant effect if applicable
      if (card.effectType === "instant") {
        s = resolveHeroInstantEffect(s, getPlayer(s, playerId)!, card);
      } else {
        s = recomputeAllModifiers(s);
      }
      // Quencher: whenever a Moisture card enters compost, draw 1 extra card
      s = triggerQuencher(s, playerId, card);

      const winner = checkWinCondition(s);
      if (winner) {
        s = { ...s, winner, phase: "game_over" };
        addLog(s, `🎉 ${getPlayer(s, winner)!.name} wins!`);
      }
      return { state: s };
    }

    case "choose_compost_to_swap_breezy": {
      const myCardId = decisionData.myCardId as string;
      const theirCardId = decisionData.theirCardId as string;
      const theirPlayerId = decisionData.theirPlayerId as string;

      const myCard = player.compostPile.find((c) => c.id === myCardId);
      const theirPlayer = getPlayer(s, theirPlayerId);
      if (!myCard || !theirPlayer) return { state, error: "Invalid swap cards" };
      const theirCard = theirPlayer.compostPile.find((c) => c.id === theirCardId);
      if (!theirCard) return { state, error: "Their card not found" };

      if (moistureProtected(theirPlayer) && getEffectiveFunction(theirCard) === "Moisture") {
        return { state, error: `${theirPlayer.name}'s Moisture cards are protected by the Soggy Saver!` };
      }

      const updatedMe = {
        ...player,
        compostPile: [
          ...player.compostPile.filter((c) => c.id !== myCardId),
          theirCard,
        ],
      };
      const updatedThem = {
        ...theirPlayer,
        compostPile: [
          ...theirPlayer.compostPile.filter((c) => c.id !== theirCardId),
          myCard,
        ],
      };
      s = updatePlayer(s, updatedMe);
      s = updatePlayer(s, updatedThem);
      addLog(
        s,
        `${player.name} swapped ${myCard.name} with ${theirPlayer.name}'s ${theirCard.name}.`
      );
      return { state: s };
    }

    case "choose_under_web_hand_card": {
      const chosenId = decisionData.cardId as string;
      const myCard = player.hand.find((c) => c.id === chosenId);
      if (!myCard) return { state, error: "Card not in hand" };

      // Now need to pick discard card
      s = {
        ...s,
        pendingDecision: {
          type: "choose_under_web_discard_card",
          playerId,
          cardId: decision.cardId,
          options: s.discardPile.map((c) => ({ cardId: c.id, cardName: c.name })),
          prompt: `${player.name}: Choose a card from the discard pile to take into your hand.`,
          meta: { fromHandCardId: chosenId },
        },
      };
      // Remove my card from hand
      const updatedPlayer = {
        ...player,
        hand: player.hand.filter((c) => c.id !== chosenId),
      };
      s = {
        ...s,
        discardPile: [myCard, ...s.discardPile],
      };
      s = updatePlayer(s, updatedPlayer);
      return { state: s };
    }

    case "choose_under_web_discard_card": {
      const chosenId = decisionData.cardId as string;
      const discardCard = s.discardPile.find((c) => c.id === chosenId);
      if (!discardCard) return { state, error: "Card not in discard" };

      const updatedPlayer = {
        ...player,
        hand: [...player.hand, discardCard],
      };
      s = {
        ...s,
        discardPile: s.discardPile.filter((c) => c.id !== chosenId),
      };
      s = updatePlayer(s, updatedPlayer);
      addLog(
        s,
        `${player.name} swapped a hand card with ${discardCard.name} from discard (The Under-Web).`
      );
      return { state: s };
    }

    case "choose_rainstorm_play": {
      // Optional: play some Moisture/Nitrogen cards to compost
      const cardIds = (decisionData.cardIds as string[]) ?? [];
      for (const cid of cardIds) {
        const plasticMod = s.activeModifiers.find(
          (m) => m.cardId === "plastic_contamination"
        );
        if (plasticMod) break;

        const currentPlayer = getPlayer(s, playerId)!;
        const cardToPlay = currentPlayer.hand.find(
          (c) =>
            c.id === cid &&
            (c.function === "Moisture" || c.function === "Nitrogen") &&
            c.type === "hero"
        );
        if (!cardToPlay) continue;

        const updated = {
          ...currentPlayer,
          hand: currentPlayer.hand.filter((c) => c.id !== cid),
          compostPile: [...currentPlayer.compostPile, cardToPlay],
        };
        s = updatePlayer(s, updated);
        addLog(s, `${player.name} played ${cardToPlay.name} to compost (Rainstorm).`);

        if (cardToPlay.effectType === "instant") {
          s = resolveHeroInstantEffect(s, getPlayer(s, playerId)!, cardToPlay);
        }
        // Quencher: whenever a Moisture card enters compost, draw 1 extra card
        s = triggerQuencher(s, playerId, cardToPlay);
      }
      if (cardIds.length === 0) {
        addLog(s, `${player.name} chose not to play any Moisture/Nitrogen cards.`);
      }
      const winner = checkWinCondition(s);
      if (winner) {
        s = { ...s, winner, phase: "game_over" };
        addLog(s, `🎉 ${getPlayer(s, winner)!.name} wins!`);
      }
      return { state: s };
    }

    case "choose_rot_roulette_keep": {
      const keepIds = (decisionData.keepCardIds as string[]) ?? [];
      if (keepIds.length !== 2) {
        return { state, error: "Must keep exactly 2 cards" };
      }
      const drawnIds = (decision.meta?.drawnCardIds as string[]) ?? [];
      const discardIds = drawnIds.filter((id) => !keepIds.includes(id));

      // Discard the unchosen cards
      let currentPlayer = getPlayer(s, playerId)!;
      for (const cid of discardIds) {
        const card = currentPlayer.hand.find((c) => c.id === cid);
        if (card) {
          currentPlayer = {
            ...currentPlayer,
            hand: currentPlayer.hand.filter((c) => c.id !== cid),
          };
          s = {
            ...s,
            discardPile: [card, ...s.discardPile],
          };

          // Hot Head check for Carbon discards (only for the player who discarded)
          if (card.function === "Carbon") {
            const hotHeadOwner = getPlayer(s, playerId)!;
            if (hotHeadOwner.compostPile.some((c) => c.id === "hot_head")) {
              s = drawCard(s, getPlayer(s, playerId)!);
              addLog(s, `${hotHeadOwner.name} drew 1 card (The Hot Head — Carbon discarded).`);
            }
          }
        }
      }
      s = updatePlayer(s, currentPlayer);
      addLog(s, `${player.name} kept 2 cards from Rot Roulette.`);

      // Must now play 1 of the kept cards — set pending decision
      const keptCards = currentPlayer.hand.filter((c) => keepIds.includes(c.id));
      s = {
        ...s,
        pendingDecision: {
          type: "choose_card_from_hand",
          playerId,
          cardId: decision.cardId,
          options: keptCards.map((c) => ({ cardId: c.id, cardName: c.name })),
          prompt: `${player.name}: Rot Roulette — choose 1 of your kept cards to play right away.`,
          meta: { rotRoulettePlay: true, playableCardIds: keepIds },
        },
      };
      return { state: s };
    }

    case "choose_discard_for_spread": {
      // Spread Nutrients: give cards to each player, then draw same number
      const cardIds = (decisionData.cardIds as string[]) ?? [];
      const othersIds = (decision.meta?.othersIds as string[]) ?? [];
      if (cardIds.length !== othersIds.length) {
        return { state, error: `Must select exactly ${othersIds.length} cards` };
      }

      let currentPlayer = getPlayer(s, playerId)!;
      for (let i = 0; i < othersIds.length; i++) {
        const cid = cardIds[i];
        const receiverId = othersIds[i];
        const card = currentPlayer.hand.find((c) => c.id === cid);
        if (!card) continue;

        currentPlayer = {
          ...currentPlayer,
          hand: currentPlayer.hand.filter((c) => c.id !== cid),
        };
        const receiver = getPlayer(s, receiverId)!;
        const updatedReceiver = {
          ...receiver,
          hand: [...receiver.hand, card],
        };
        s = updatePlayer(s, updatedReceiver);
        addLog(s, `${player.name} gave ${card.name} to ${receiver.name}.`);
      }
      s = updatePlayer(s, currentPlayer);

      // Draw same number back
      s = drawCard(s, getPlayer(s, playerId)!, cardIds.length);
      addLog(s, `${player.name} drew ${cardIds.length} card(s) back (Spread Nutrients).`);
      return { state: s };
    }

    case "choose_nitrogen_boost_discard": {
      if (decisionData.skip) {
        addLog(s, `${player.name} skipped Nitrogen Boost discard.`);
        return { state: s };
      }
      const chosenId = decisionData.cardId as string;
      const card = player.hand.find(
        (c) => c.id === chosenId && c.function === "Nitrogen"
      );
      if (!card) return { state, error: "Must choose a Nitrogen card from hand" };

      const updatedPlayer = {
        ...player,
        hand: player.hand.filter((c) => c.id !== chosenId),
      };
      s = {
        ...s,
        discardPile: [card, ...s.discardPile],
      };
      s = updatePlayer(s, updatedPlayer);
      s = drawCard(s, getPlayer(s, playerId)!, 2);
      addLog(s, `${player.name} discarded ${card.name} (Nitrogen) to draw 2 cards.`);
      return { state: s };
    }

    // Rot & Regrow ongoing: player discards 3 cards then picks 1 from discard
    case "choose_rot_regrow_discard": {
      const cardIds = decisionData.cardIds as string[] | undefined;
      if (!cardIds || cardIds.length !== 3) return { state, error: "Must discard exactly 3 cards" };
      const toDiscard = cardIds.map((id) => player.hand.find((c) => c.id === id)).filter(Boolean) as Card[];
      if (toDiscard.length !== 3) return { state, error: "One or more cards not found in hand" };

      const updatedPlayer = {
        ...player,
        hand: player.hand.filter((c) => !cardIds.includes(c.id)),
      };
      s = { ...s, discardPile: [...toDiscard, ...s.discardPile] };
      s = updatePlayer(s, updatedPlayer);
      addLog(s, `${player.name} discarded 3 cards for Rot & Regrow.`);

      if (s.discardPile.length === 0) {
        addLog(s, "Discard pile is empty — nothing to take.");
        return { state: s };
      }

      s = {
        ...s,
        pendingDecision: {
          type: "choose_rot_regrow_take",
          playerId,
          cardId: "rot_regrow",
          prompt: `${player.name}: Choose 1 card to take from the discard pile.`,
          options: s.discardPile.map((c) => ({ cardId: c.id, cardName: c.name })),
        },
      };
      return { state: s };
    }

    // Rot & Regrow ongoing: player takes 1 card from discard pile into hand
    case "choose_rot_regrow_take": {
      const chosenId = decisionData.cardId as string;
      const card = s.discardPile.find((c) => c.id === chosenId);
      if (!card) return { state, error: "Card not found in discard pile" };

      const updatedPlayer = { ...player, hand: [...player.hand, card] };
      s = { ...s, discardPile: s.discardPile.filter((c) => c.id !== chosenId) };
      s = updatePlayer(s, updatedPlayer);
      addLog(s, `${player.name} took ${card.name} from discard pile (Rot & Regrow).`);
      return { state: s };
    }

    // End-of-turn discard to hand limit — chosen by player
    case "choose_discard_to_limit": {
      const cardIds = decisionData.cardIds as string[] | undefined;
      const required = (decision as any).meta?.count ?? 1;
      if (!cardIds || cardIds.length !== required) {
        return { state, error: `Must discard exactly ${required} card(s)` };
      }
      const toDiscard = cardIds.map((id) => player.hand.find((c) => c.id === id)).filter(Boolean) as Card[];
      if (toDiscard.length !== required) return { state, error: "One or more cards not found in hand" };

      const updatedPlayer = { ...player, hand: player.hand.filter((c) => !cardIds.includes(c.id)) };
      s = { ...s, discardPile: [...toDiscard, ...s.discardPile] };
      s = updatePlayer(s, updatedPlayer);
      addLog(s, `${player.name} discarded ${toDiscard.map((c) => c.name).join(", ")} to meet hand limit.`);

      // Now advance the turn
      s = advanceTurnState(s);
      return { state: s };
    }

    // Player chooses which function slot a multi-layer hero fills
    case "choose_function": {
      const chosenFn = decisionData.function as string;
      const pendingCard = decision.meta?.pendingCard as Card | undefined;
      if (!pendingCard) return { state, error: "No pending card to place" };
      const allFns = [...new Set([pendingCard.function, ...(pendingCard.alternateFunctions ?? [])])];
      if (!allFns.includes(chosenFn)) return { state, error: "Invalid function choice" };

      const cardWithChoice: Card = { ...pendingCard, chosenFunction: chosenFn };
      const updatedPlayer = {
        ...player,
        compostPile: [...player.compostPile, cardWithChoice],
      };
      s = updatePlayer(s, updatedPlayer);
      addLog(s, `${player.name} placed ${pendingCard.name} into the ${chosenFn} slot.`);

      if (cardWithChoice.effectType === "ongoing") {
        s = recomputeAllModifiers(s);
        addLog(s, `${cardWithChoice.name} ongoing effect is now active for ${player.name}.`);
      } else {
        s = resolveHeroInstantEffect(s, getPlayer(s, playerId)!, cardWithChoice);
      }
      // Quencher: whenever a Moisture card enters compost, draw 1 extra card
      s = triggerQuencher(s, playerId, cardWithChoice);

      // Check win
      const winner = checkWinCondition(s);
      if (winner) {
        s = { ...s, phase: "game_over", winner };
        const winnerPlayer = getPlayer(s, winner)!;
        addLog(s, `🎉 ${winnerPlayer.name} wins! They collected one hero from each function!`);
      }
      return { state: s };
    }

    // Player moves a multi-layer hero card already in compost to a different slot
    case "choose_move_function": {
      const chosenFn = decisionData.function as string;
      const moveCardId = decision.meta?.moveCardId as string | undefined;
      if (!moveCardId) return { state, error: "No card to move" };

      const cardIdx = player.compostPile.findIndex((c) => c.id === moveCardId);
      if (cardIdx < 0) return { state, error: "Card not found in compost pile" };

      const cardToMove = player.compostPile[cardIdx];
      if (!(ALL_HERO_FUNCTIONS as readonly string[]).includes(chosenFn)) return { state, error: "Invalid function choice" };

      // Ensure the target slot is currently empty (or the same card is there)
      const currentOccupant = player.compostPile.find(
        (c, i) => i !== cardIdx && getEffectiveFunction(c) === chosenFn
      );
      if (currentOccupant) return { state, error: `The ${chosenFn} slot is already filled` };

      const movedCard: Card = { ...cardToMove, chosenFunction: chosenFn };
      const newPile = player.compostPile.map((c, i) => (i === cardIdx ? movedCard : c));
      const updatedPlayer = { ...player, compostPile: newPile };
      s = updatePlayer(s, updatedPlayer);
      addLog(s, `${player.name} moved ${cardToMove.name} to the ${chosenFn} slot.`);

      const winner = checkWinCondition(s);
      if (winner) {
        s = { ...s, phase: "game_over", winner };
        const winnerPlayer = getPlayer(s, winner)!;
        addLog(s, `🎉 ${winnerPlayer.name} wins! They collected one hero from each function!`);
      }
      return { state: s };
    }

    default:
      return { state, error: `Unknown decision type: ${decision.type}` };
  }
}

// ─────────────────────────────────────────────
// DRAW CARD (action)
// ─────────────────────────────────────────────
export function drawCardAction(
  state: GameState,
  playerId: string
): { state: GameState; error?: string } {
  if (state.phase !== "draw" && state.phase !== "play") {
    return { state, error: "Cannot draw a card in this phase" };
  }
  const player = getPlayer(state, playerId);
  if (!player) return { state, error: "Player not found" };

  const currentPlayer = state.players[state.currentPlayerIndex];
  if (currentPlayer.id !== playerId) {
    return { state, error: "It's not your turn" };
  }

  let s = drawCard(state, player);
  addLog(s, `${player.name} drew a card.`);

  // Transition to play phase — ongoing card benefits are now player-triggered
  // via the "Activate Effect" button (activateOngoing), not auto-fired on draw.
  s = { ...s, phase: "play" };
  return { state: s };
}

// ─────────────────────────────────────────────
// END TURN
// ─────────────────────────────────────────────
function advanceTurnState(s: GameState): GameState {
  if (s.extraTurn) {
    const cp = s.players[s.currentPlayerIndex];
    addLog(s, `${cp.name} takes another turn!`);
    return { ...s, extraTurn: false, phase: "draw", heroPlayedThisTurn: false, actionPlayedThisTurn: false, ongoingBenefitUsedThisTurn: false };
  }

  let nextIdx = nextPlayerIndex(s);
  let nextPlayer = s.players[nextIdx];
  let skipsChecked = 0;
  while (nextPlayer.skipsNextTurn && skipsChecked < s.players.length) {
    addLog(s, `${nextPlayer.name} skips their turn!`);
    const updated = { ...nextPlayer, skipsNextTurn: false };
    s = updatePlayer(s, updated);
    nextIdx = (nextIdx + 1) % s.players.length;
    nextPlayer = s.players[nextIdx];
    skipsChecked++;
  }

  s = {
    ...s,
    currentPlayerIndex: nextIdx,
    phase: "draw",
    turnNumber: s.turnNumber + 1,
    heroPlayedThisTurn: false,
    actionPlayedThisTurn: false,
    ongoingBenefitUsedThisTurn: false,
  };
  addLog(s, `--- ${s.players[nextIdx].name}'s turn begins ---`);
  return s;
}

export function endTurn(
  state: GameState,
  playerId: string
): { state: GameState; error?: string } {
  const currentPlayer = state.players[state.currentPlayerIndex];
  if (currentPlayer.id !== playerId) {
    return { state, error: "It's not your turn" };
  }
  if (state.pendingDecision) {
    return { state, error: "Must resolve pending decision first" };
  }

  let s = recomputeAllModifiers(state);
  const player = getPlayer(s, playerId)!;

  // Player must choose which cards to discard if hand exceeds limit
  if (player.hand.length > player.maxHandSize) {
    const discardCount = player.hand.length - player.maxHandSize;
    s = {
      ...s,
      pendingDecision: {
        type: "choose_discard_to_limit",
        playerId,
        prompt: `${player.name}: Too many cards! Discard ${discardCount} card${discardCount !== 1 ? "s" : ""} (max hand: ${player.maxHandSize}).`,
        options: player.hand.map((c) => ({ cardId: c.id, cardName: c.name })),
        meta: { count: discardCount },
      },
    };
    return { state: s };
  }

  return { state: advanceTurnState(s) };
}

// ─────────────────────────────────────────────
// SETUP GAME
// ─────────────────────────────────────────────
export function createGameState(
  gameId: string,
  playerNames: string[],
  mode: "facilitator" | "standalone",
  botPlayerIndices: number[] = []
): GameState {
  const deck = shuffle(buildDeck(getAllOverrides(), getAllCopies()));
  const players: PlayerState[] = playerNames.map((name, i) => ({
    id: `player_${i}`,
    name,
    hand: [],
    compostPile: [],
    skipsNextTurn: false,
    maxHandSize: 5,
    drawsExtraCard: false,
    isBot: botPlayerIndices.includes(i),
  }));

  let state: GameState = {
    gameId,
    mode,
    phase: "draw",
    currentPlayerIndex: 0,
    players,
    deck,
    discardPile: [],
    activeModifiers: [],
    pendingDecision: null,
    log: [],
    winner: null,
    turnNumber: 1,
    extraTurn: false,
    heroPlayedThisTurn: false,
    actionPlayedThisTurn: false,
    ongoingActionCard: null,
    ongoingBenefitUsedThisTurn: false,
  };

  // Deal 3 cards to each player
  for (const player of state.players) {
    state = drawCard(state, getPlayer(state, player.id)!, 3);
  }

  addLog(state, `Game started! ${playerNames.join(", ")} are playing.`);
  addLog(state, `--- ${state.players[0].name}'s turn begins ---`);

  return state;
}

// ─────────────────────────────────────────────
// ACTIVATE ONGOING ACTION CARD
// ─────────────────────────────────────────────
export function activateOngoing(
  state: GameState,
  playerId: string
): { state: GameState; error?: string } {
  const player = getPlayer(state, playerId);
  if (!player) return { state, error: "Player not found" };
  if (state.pendingDecision) return { state, error: "Must resolve pending decision first" };

  const currentPlayer = state.players[state.currentPlayerIndex];
  if (currentPlayer.id !== playerId) return { state, error: "It's not your turn" };
  if (state.phase !== "play") return { state, error: "Can only activate during play phase" };

  const ongoing = state.ongoingActionCard;
  if (!ongoing) return { state, error: "No ongoing action card is active" };

  if (state.ongoingBenefitUsedThisTurn) {
    return { state, error: `You have already used ${ongoing.name}'s benefit this turn` };
  }

  // Mark benefit as used immediately (even for decision-based effects — starting the
  // decision uses up the activation, preventing a second activation if the player skips).
  const stateWithFlag: GameState = { ...state, ongoingBenefitUsedThisTurn: true };

  switch (ongoing.id) {
    case "hot_pile_bonus": {
      const decomposerCount = player.compostPile.filter(
        (c) => getEffectiveFunction(c) === "Decomposer"
      ).length;
      if (decomposerCount < 2) {
        return { state, error: "Hot Pile Bonus requires 2 Decomposer cards in your compost pile" };
      }
      let s = drawCard(stateWithFlag, getPlayer(stateWithFlag, playerId)!);
      addLog(s, `${player.name} drew 1 card (Hot Pile Bonus — 2 Decomposers in pile).`);
      return { state: s };
    }

    case "critical_mass": {
      const pile = player.compostPile;
      const hasDoubleLayer = pile.some((c1, i) =>
        pile.some((c2, j) => j !== i && c1.layer === c2.layer && c1.layer !== null)
      );
      if (!hasDoubleLayer) {
        return { state, error: "Critical Mass requires 2 cards of the same layer in your compost pile" };
      }
      let s = drawCard(stateWithFlag, getPlayer(stateWithFlag, playerId)!);
      addLog(s, `${player.name} drew 1 card (Critical Mass — 2 cards of same layer).`);
      return { state: s };
    }

    case "rot_regrow": {
      if (player.hand.length < 3) {
        return { state, error: "Need at least 3 cards in hand to activate Rot & Regrow" };
      }
      const s = {
        ...stateWithFlag,
        pendingDecision: {
          type: "choose_rot_regrow_discard" as const,
          playerId,
          cardId: "rot_regrow",
          prompt: `${player.name}: Rot & Regrow — select 3 cards from your hand to discard.`,
          options: player.hand.map((c) => ({ cardId: c.id, cardName: c.name })),
          meta: { count: 3 },
        },
      };
      return { state: s };
    }

    case "nitrogen_boost": {
      const nitrogenCards = player.hand.filter((c) => c.function === "Nitrogen");
      if (nitrogenCards.length === 0) {
        return { state, error: "No Nitrogen cards in hand to discard for Nitrogen Boost" };
      }
      const s = {
        ...stateWithFlag,
        pendingDecision: {
          type: "choose_nitrogen_boost_discard" as const,
          playerId,
          cardId: "nitrogen_boost",
          prompt: `${player.name}: Nitrogen Boost — discard 1 Nitrogen card from your hand to draw 2 cards.`,
          options: nitrogenCards.map((c) => ({ cardId: c.id, cardName: c.name })),
          meta: { optional: true },
        },
      };
      return { state: s };
    }

    default:
      return { state, error: `${ongoing.name} has no activatable player benefit` };
  }
}

// ─────────────────────────────────────────────
// MOVE CARD LAYER (action)
// Initiates the choose_move_function decision for a multi-layer hero already in compost.
// ─────────────────────────────────────────────
const ALL_HERO_FUNCTIONS = ["Airflow", "Carbon", "Decomposer", "Moisture", "Nitrogen"] as const;

export function moveCardLayer(
  state: GameState,
  playerId: string,
  cardId: string,
  targetFunction?: string
): { state: GameState; error?: string } {
  const player = getPlayer(state, playerId);
  if (!player) return { state, error: "Player not found" };
  if (state.pendingDecision) return { state, error: "Must resolve pending decision first" };

  const card = player.compostPile.find((c) => c.id === cardId);
  if (!card) return { state, error: "Card not found in compost pile" };

  if (card.type !== "hero") return { state, error: "Only hero cards can be moved between slots" };

  const currentFn = getEffectiveFunction(card);
  // Occupied slots (by other cards) cannot be targeted
  const occupiedFunctions = new Set(
    player.compostPile.filter((c) => c.id !== cardId).map((c) => getEffectiveFunction(c))
  );
  // Only allow slots that this card's layer/function actually permits
  const cardValidFns = getCardValidFunctions(card);
  const availableTargets = cardValidFns.filter(
    (fn) => fn !== currentFn && !occupiedFunctions.has(fn)
  );

  if (availableTargets.length === 0) {
    const validList = cardValidFns.join(", ");
    return { state, error: `${card.name} can only occupy its own function slot(s): ${validList}. No alternate empty slot is available.` };
  }

  // If a target function is provided directly (e.g. from drag-and-drop), apply immediately
  if (targetFunction) {
    if (!(availableTargets as readonly string[]).includes(targetFunction)) {
      return { state, error: `Cannot move card to ${targetFunction}: slot not available` };
    }
    const newPile = player.compostPile.map((c) =>
      c.id === cardId ? { ...c, chosenFunction: targetFunction, function: targetFunction } : c
    );
    const newPlayers = state.players.map((p) =>
      p.id === playerId ? { ...p, compostPile: newPile } : p
    );
    return {
      state: {
        ...state,
        players: newPlayers,
        log: [...state.log, `${player.name} moved ${card.name} to the ${targetFunction} slot`],
      },
    };
  }

  // Otherwise show a decision modal so the player can pick the target slot
  let s = {
    ...state,
    pendingDecision: {
      type: "choose_move_function" as const,
      playerId,
      cardId,
      prompt: `${player.name}: Choose a new category slot for ${card.name}.`,
      options: availableTargets.map((fn) => ({ function: fn })),
      meta: { moveCardId: cardId },
    },
  };
  return { state: s };
}

// ─────────────────────────────────────────────
// WAITING ROOM
// ─────────────────────────────────────────────

export function createWaitingRoom(
  gameId: string,
  hostName: string,
  maxPlayers: number,
  mode: "online"
): GameState {
  const host: PlayerState = {
    id: "player_0",
    name: hostName,
    hand: [],
    compostPile: [],
    skipsNextTurn: false,
    maxHandSize: 5,
    drawsExtraCard: false,
  };
  return {
    gameId,
    mode,
    phase: "waiting",
    currentPlayerIndex: 0,
    players: [host],
    deck: [],
    discardPile: [],
    activeModifiers: [],
    pendingDecision: null,
    log: [],
    winner: null,
    turnNumber: 1,
    extraTurn: false,
    heroPlayedThisTurn: false,
    actionPlayedThisTurn: false,
    ongoingActionCard: null,
    maxPlayers,
  };
}

export function removePlayerFromRoom(
  state: GameState,
  playerId: string
): { state: GameState; removedIndex: number } | { error: string } {
  if (state.phase !== "waiting") {
    return { error: "Can only remove players during the waiting phase" };
  }
  const idx = state.players.findIndex((p) => p.id === playerId);
  if (idx === -1) {
    return { error: "Player not found" };
  }
  const newPlayers = state.players.filter((p) => p.id !== playerId);
  return {
    state: { ...state, players: newPlayers },
    removedIndex: idx,
  };
}

export function addPlayerToRoom(
  state: GameState,
  playerName: string
): { state: GameState; playerIndex: number } | { state: GameState; error: string } {
  if (state.phase !== "waiting") return { state, error: "Game already started" };
  if (state.players.length >= (state.maxPlayers ?? 4))
    return { state, error: "Room is full" };

  const playerIndex = state.players.length;
  const newPlayer: PlayerState = {
    id: `player_${playerIndex}`,
    name: playerName,
    hand: [],
    compostPile: [],
    skipsNextTurn: false,
    maxHandSize: 5,
    drawsExtraCard: false,
  };
  return {
    state: { ...state, players: [...state.players, newPlayer] },
    playerIndex,
  };
}

// ─────────────────────────────────────────────
// BOT AI
// ─────────────────────────────────────────────

/**
 * Execute a single bot turn: draw → maybe play best hero → end turn.
 * Returns the new state (which will be at the next player's draw phase).
 */
function botTakeTurn(state: GameState): GameState {
  const player = state.players[state.currentPlayerIndex];
  if (!player.isBot) return state;

  // 1. Draw card
  let s = drawCard(state, player);
  s = { ...s, phase: "play" };
  addLog(s, `${player.name} (Bot) drew a card.`);

  // 2. Find best hero to play (fills a missing function in their pile)
  const updatedPlayer = getPlayer(s, player.id)!;
  const coveredFunctions = new Set(
    updatedPlayer.compostPile.map((c) => getEffectiveFunction(c))
  );
  const missingFunctions = WIN_FUNCTIONS.filter((f) => !coveredFunctions.has(f));

  let bestHero: Card | null = null;
  let bestChosenFn: string | null = null;

  for (const card of updatedPlayer.hand) {
    if (card.type !== "hero") continue;
    const validFns = [...new Set([card.function, ...(card.alternateFunctions ?? [])])];
    const matchMissing = validFns.filter((f) => (missingFunctions as string[]).includes(f));
    if (matchMissing.length > 0) {
      bestHero = card;
      bestChosenFn = matchMissing[0];
      break;
    }
    // If no missing function match, but card fills a slot we don't have at all,
    // still a candidate (lower priority)
    if (!bestHero && validFns.some((f) => !(coveredFunctions as Set<string>).has(f))) {
      bestHero = card;
      bestChosenFn = validFns.find((f) => !(coveredFunctions as Set<string>).has(f)) ?? null;
    }
  }

  if (bestHero) {
    const playResult = playCard(s, player.id, bestHero.id);
    if (!playResult.error) {
      s = playResult.state;
      // Resolve choose_function decision if triggered (multi-function hero)
      if (s.pendingDecision?.type === "choose_function" && bestChosenFn) {
        const resolveResult = resolveDecision(s, player.id, { function: bestChosenFn });
        if (!resolveResult.error) s = resolveResult.state;
      }
    }
  }

  // 3. End turn
  const endResult = endTurn(s, player.id);
  if (!endResult.error) s = endResult.state;
  else {
    // If endTurn hit choose_discard_to_limit, auto-discard excess cards (least useful first)
    if (s.pendingDecision?.type === "choose_discard_to_limit") {
      const count = (s.pendingDecision.meta?.count as number) ?? 1;
      const toDiscard = s.pendingDecision.options!.slice(0, count) as { cardId: string }[];
      let rs = s;
      for (const opt of toDiscard) {
        const rr = resolveDecision(rs, player.id, { cardId: opt.cardId });
        if (!rr.error) rs = rr.state;
      }
      s = rs;
    }
  }

  return s;
}

/**
 * While the current player is a bot and the game is in draw phase,
 * execute their turn automatically. Call after any state mutation that
 * might have advanced the turn.
 */
export function runBotTurnsIfNeeded(state: GameState): GameState {
  let s = state;
  let iterations = 0;
  while (
    s.phase === "draw" &&
    s.phase !== "game_over" &&
    s.players[s.currentPlayerIndex]?.isBot &&
    iterations < 20
  ) {
    s = botTakeTurn(s);
    iterations++;
    if (s.phase === "game_over") break;
  }
  return s;
}

export function launchGame(
  state: GameState
): { state: GameState; error?: string } {
  if (state.phase !== "waiting") return { state, error: "Game is not in waiting phase" };
  if (state.players.length < 2) return { state, error: "Need at least 2 players to start" };

  const deck = shuffle(buildDeck(getAllOverrides(), getAllCopies()));
  let s: GameState = {
    ...state,
    phase: "draw",
    deck,
    discardPile: [],
    turnNumber: 1,
    extraTurn: false,
    heroPlayedThisTurn: false,
    actionPlayedThisTurn: false,
  };

  for (const player of s.players) {
    s = drawCard(s, getPlayer(s, player.id)!, 3);
  }

  addLog(s, `Game started! ${s.players.map((p) => p.name).join(", ")} are playing.`);
  addLog(s, `--- ${s.players[0].name}'s turn begins ---`);

  return { state: s };
}
