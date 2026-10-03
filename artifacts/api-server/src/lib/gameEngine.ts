import { Card, buildDeck, WIN_FUNCTIONS } from "./cards.js";
import { getAllOverrides } from "./imageKeyStore.js";
import { getAllCopies } from "./cardCopiesStore.js";

function removeOneById<T extends { id: string }>(arr: T[], id: string): T[] {
  const idx = arr.findIndex((c) => c.id === id);
  if (idx === -1) return arr;
  return [...arr.slice(0, idx), ...arr.slice(idx + 1)];
}

export type BotSkillLevel = "easy" | "medium" | "hard";

export interface PlayerState {
  id: string;
  name: string;
  hand: Card[];
  compostPile: Card[];
  skipsNextTurn: boolean;
  maxHandSize: number;
  /** Legacy wire-compatibility field; Hot Pile no longer sets a passive draw flag. */
  drawsExtraCard: boolean;
  isBot: boolean;
  botSkillLevel?: BotSkillLevel;
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
  eventId?: string;
  mode: "facilitator" | "standalone" | "online" | "facilitated";
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
  turnSequence?: number;
  turnTimerSeconds?: number;
  turnDeadlineAt?: number | null;
  turnDeadlineKey?: string | null;
  turnTimerActorKey?: string | null;
  turnTimerRemainingMs?: number | null;
  extraTurn: boolean;
  heroPlayedThisTurn: boolean;
  actionPlayedThisTurn: boolean;
  ongoingActionCard: Card | null;
  /** True once the current player has already activated their ongoing-action-card benefit this turn. */
  ongoingBenefitUsedThisTurn: boolean;
  maxPlayers?: number;
  /** Facilitated mode only: true while the facilitator has paused the game. */
  paused?: boolean;
  /** Facilitated mode only: rich announcement of the most recent card effect, broadcast to all players. */
  lastEffect?: EffectAnnouncement | null;
  /** Epoch ms when the room was created (online/facilitated). */
  createdAt?: number;
  /** Facilitated mode: optional session label chosen by the facilitator. */
  label?: string;
  /** Registered user id of the room creator (online/facilitated). */
  facilitatorId?: string;
  /** New facilitated sessions keep the facilitator outside the player seats. */
  hostIsSpectator?: boolean;
  /** Facilitated mode: latest broadcast message from the facilitator, shown to all tables. */
  hostMessage?: { id: string; text: string; ts: number } | null;
  /** Facilitated mode: participant question flags for the facilitator. */
  questions?: QuestionFlag[];
  /** True when the facilitator ended the session manually. */
  endedByHost?: boolean;
  /** Epoch ms when the game finished (win or manual end). */
  endedAt?: number;
  /** Epoch ms for real game activity (player actions, start, facilitator resolve). */
  lastMeaningfulActivityAt?: number;
}

export interface QuestionFlag {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  ts: number;
  resolved: boolean;
}

/** Structured description of a resolved effect, for spectator visualization in facilitated mode. */
export interface EffectEvent {
  kind: "draw" | "discard" | "transfer" | "swap" | "skip" | "pile_shift" | "modifier" | "info";
  /** Player ids involved (source first, then target where applicable). */
  playerIds?: string[];
  /** Human-readable one-liner, safe to show to everyone (never reveals hidden hands). */
  text: string;
  /** Machine-readable outcome. Card details are only present for public cards. */
  fact?: EffectFact;
}

export interface EffectFact {
  kind:
    | "draw"
    | "hand_discard"
    | "hand_transfer"
    | "hand_loss"
    | "pile_gain"
    | "pile_loss"
    | "pile_transfer"
    | "compost_to_hand"
    | "discard_to_hand"
    | "skip"
    | "pile_shift"
    | "slot_change"
    | "ongoing_set"
    | "ongoing_removed";
  /** Seat that played or activated the originating effect. */
  actorId: string;
  /** Affected players, or source then recipient for a transfer. */
  playerIds: string[];
  count: number;
  /** Names and functions are allowed only for cards already public in a pile/discard. */
  cardName?: string;
  function?: string;
  previousFunction?: string;
  previousCardName?: string;
  sourcePlayerId?: string;
  targetPlayerId?: string;
}

export interface EffectAnnouncement {
  /** Unique per announcement so clients can detect changes. */
  id: string;
  cardId: string;
  cardName: string;
  cardText: string;
  imageKey: string | null;
  playedById: string;
  playedByName: string;
  /** Action taken; absent in announcements persisted by older versions. */
  verb?: "played" | "activated" | "moved";
  /** Public seat labels used to phrase structured facts for each viewer. */
  players?: Array<{ id: string; name: string }>;
  /** Safe public outcome lines; raw game-log entries are never copied here. */
  outcome: string[];
  events: EffectEvent[];
  /** Resolved only for the matching token-scoped viewer by serializeState. */
  privateEventsByPlayerId?: Record<string, string[]>;
  /** Private detail populated by the per-viewer serializer. */
  privateEvents?: string[];
  /** Instance identities/functions stay scoped to each affected hand owner. */
  privateFactsByPlayerId?: Record<string, EffectFact[]>;
  privateFacts?: EffectFact[];
  /** Server-only provenance that named discard-to-hand facts came from an explicit pick. */
  trustedExplicitDiscardToHand?: true;
}

/** Per-call engine facts used only while building the immediate effect announcement. */
export interface EngineOperationTrace {
  draws: Array<{ playerId: string; cardIds: string[] }>;
  handDiscards: Array<{ playerId: string; card: Card }>;
  discardToHand: Array<{ playerId: string; card: Card }>;
}

interface ActiveEngineOperationTrace extends EngineOperationTrace {
  trackedHandOwners: Map<string, string>;
  trackedCards: Map<string, Card>;
  playedCardIds: Set<string>;
  recordedHandDiscardIds: Set<string>;
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

let activeEngineOperationTrace: ActiveEngineOperationTrace | null = null;

function recordHandCardDiscard(playerId: string, card: Card): void {
  const trace = activeEngineOperationTrace;
  if (!trace || trace.playedCardIds.has(card.id) || trace.recordedHandDiscardIds.has(card.id)) return;
  trace.handDiscards.push({ playerId, card });
  trace.recordedHandDiscardIds.add(card.id);
}

function recordDiscardedHandCardsPresent(state: GameState): void {
  const trace = activeEngineOperationTrace;
  if (!trace) return;
  const discardIds = new Set(state.discardPile.map((card) => card.id));
  for (const cardId of trace.recordedHandDiscardIds) {
    if (!discardIds.has(cardId)) trace.recordedHandDiscardIds.delete(cardId);
  }
  for (const [cardId, playerId] of trace.trackedHandOwners) {
    if (!discardIds.has(cardId)) continue;
    const card = trace.trackedCards.get(cardId);
    if (card) recordHandCardDiscard(playerId, card);
  }
}

/** Explicit public choice from the discard pile; random reshuffles never use this path. */
function recordExplicitDiscardToHand(playerId: string, card: Card): void {
  const trace = activeEngineOperationTrace;
  if (!trace) return;
  trace.discardToHand.push({ playerId, card });
  trace.recordedHandDiscardIds.delete(card.id);
  trace.trackedHandOwners.set(card.id, playerId);
  trace.trackedCards.set(card.id, card);
}

/**
 * Captures ephemeral operations for one synchronous engine action. The trace
 * is returned separately and is never added to, saved with, or broadcast from
 * GameState.
 */
export function captureEngineOperations<T extends { state: GameState; error?: string }>(
  before: GameState,
  operation: () => T,
  options: { playedCardId?: string } = {},
): { result: T; trace: EngineOperationTrace } {
  const trace: ActiveEngineOperationTrace = {
    draws: [],
    handDiscards: [],
    discardToHand: [],
    trackedHandOwners: new Map(before.players.flatMap((player) =>
      player.hand.map((card) => [card.id, player.id] as const))),
    trackedCards: new Map(before.players.flatMap((player) =>
      player.hand.map((card) => [card.id, card] as const))),
    playedCardIds: new Set(options.playedCardId ? [options.playedCardId] : []),
    recordedHandDiscardIds: new Set(),
  };
  const previousTrace = activeEngineOperationTrace;
  activeEngineOperationTrace = trace;
  try {
    const result = operation();
    if (!result.error) recordDiscardedHandCardsPresent(result.state);
    return {
      result,
      trace: {
        draws: trace.draws.map((draw) => ({ playerId: draw.playerId, cardIds: [...draw.cardIds] })),
        handDiscards: [...trace.handDiscards],
        discardToHand: [...trace.discardToHand],
      },
    };
  } finally {
    activeEngineOperationTrace = previousTrace;
  }
}

/** Combines the user action trace with a subsequent bot-completion trace. */
export function mergeEngineOperationTraces(
  ...traces: Array<EngineOperationTrace | undefined>
): EngineOperationTrace {
  return {
    draws: traces.flatMap((trace) => trace?.draws ?? []),
    handDiscards: traces.flatMap((trace) => trace?.handDiscards ?? []),
    discardToHand: traces.flatMap((trace) => trace?.discardToHand ?? []),
  };
}

function drawCard(
  state: GameState,
  player: PlayerState,
  count = 1
): GameState {
  let s = { ...state };
  const drawnCardIds: string[] = [];
  for (let i = 0; i < count; i++) {
    // Observe hidden-hand cards in discard before a reshuffle can put one back
    // into the same owner's hand and erase its final-state transition.
    recordDiscardedHandCardsPresent(s);
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
    drawnCardIds.push(card.id);
    if (activeEngineOperationTrace) {
      activeEngineOperationTrace.recordedHandDiscardIds.delete(card.id);
      activeEngineOperationTrace.trackedHandOwners.set(card.id, player.id);
      activeEngineOperationTrace.trackedCards.set(card.id, card);
    }
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
  if (drawnCardIds.length > 0) {
    activeEngineOperationTrace?.draws.push({ playerId: player.id, cardIds: drawnCardIds });
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
      recordHandCardDiscard(currentPlayer.id, discarded);
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

/** True if this card instance matches the given template/design ID. */
function cardIs(card: Card, templateId: string): boolean {
  return getCardBaseId(card) === templateId;
}

/** Supports older saved card instances that predate the explicit baseId field. */
function getCardBaseId(card: Card): string {
  return card.baseId ?? card.id.split("__", 1)[0] ?? card.id;
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

/** Hot Pile counts a card once if Decomposer is its placed or available function. */
function countsForHotPile(card: Card): boolean {
  return getEffectiveFunction(card) === "Decomposer" || cardHasFunctionNatively(card, "Decomposer");
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

  // Old Timer hero: +1 hand size
  if (player.compostPile.some((c) => cardIs(c, "old_timer"))) {
    maxHandSize = 6;
  }

  // Dry Spell action modifier: if no Moisture in compost, max hand = 3
  const drySpell = state.activeModifiers.find((m) => m.cardId === "dry_spell");
  if (drySpell && !getHasFunction(player, "Moisture")) {
    maxHandSize = Math.min(maxHandSize, 3);
  }

  // Hot Pile's benefit is activated once by the current player, never passively.
  return { ...player, maxHandSize, drawsExtraCard: false };
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
    if (player.compostPile.some((c) => cardIs(c, "sir_stink_no_more"))) return true;
    if (player.compostPile.some((c) => cardIs(c, "stink_shield"))) return true;
  }
  // Major Brown and Stink Shield protect against soggy_pile
  if (actionCardId === "soggy_pile") {
    if (player.compostPile.some((c) => cardIs(c, "major_brown"))) return true;
    if (player.compostPile.some((c) => cardIs(c, "stink_shield"))) return true;
  }
  // Soggy Saver: Moisture cards can't be removed from compost
  // (handled in soggy_pile resolution specifically)
  return false;
}

function moistureProtected(player: PlayerState): boolean {
  return player.compostPile.some((c) => cardIs(c, "soggy_saver"));
}

function triggerQuencher(s: GameState, playerId: string, card: Card): GameState {
  if (getEffectiveFunction(card) !== "Moisture") return s;
  const owner = getPlayer(s, playerId)!;
  if (!owner.compostPile.some((c) => cardIs(c, "quencher"))) return s;
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
    cardId: getCardBaseId(card),   // always store the template ID so lookups work
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

  switch (getCardBaseId(card)) {
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
          (c) => cardHasFunctionNatively(c, "Decomposer")
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
      const ongoing = s.ongoingActionCard;
      if (!ongoing) {
        addLog(s, `No active Ongoing Action Card to discard (Legion of Life).`);
        return s;
      }
      // The ongoing card is authoritative. Older Legion saves may already have
      // lost its modifier, and legacy modifiers may store the instance ID.
      const ongoingBaseId = getCardBaseId(ongoing);
      s = {
        ...s,
        discardPile: [ongoing, ...s.discardPile],
        activeModifiers: s.activeModifiers.filter(
          (modifier) => modifier.cardId !== ongoingBaseId && modifier.cardId !== ongoing.id,
        ),
        ongoingActionCard: null,
      };
      addLog(s, `${p.name} used Legion of Life to remove ${ongoing.name}.`);
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
  const passCards: Array<{ fromId: string; card: Card }> = [];

  for (const pl of state.players) {
    if (pl.id === activePlayerId) {
      if (chosenCardId) {
        const card = pl.hand.find((c) => c.id === chosenCardId);
        if (card) passCards.push({ fromId: pl.id, card });
      }
    } else if (pl.hand.length > 0) {
      passCards.push({ fromId: pl.id, card: pl.hand[0] });
    }
  }
  return applyWormPasses(state, passCards);
}

// Helper: apply Worm Party passes where EVERY player explicitly chose their
// card. chosen maps playerId → cardId.
function applyWormPartyChain(state: GameState, chosen: Record<string, string>): GameState {
  const passCards: Array<{ fromId: string; card: Card }> = [];
  for (const pl of state.players) {
    const cid = chosen[pl.id];
    if (!cid) continue;
    const card = pl.hand.find((c) => c.id === cid);
    if (card) passCards.push({ fromId: pl.id, card });
  }
  return applyWormPasses(state, passCards);
}

// Helper: eligible Soggy Pile discards for a player (Moisture/Nitrogen,
// respecting Soggy Saver moisture protection).
function soggyCandidates(pl: PlayerState): Card[] {
  return pl.compostPile.filter((c) => {
    if (getEffectiveFunction(c) === "Moisture" && moistureProtected(pl)) return false;
    return getEffectiveFunction(c) === "Moisture" || getEffectiveFunction(c) === "Nitrogen";
  });
}

// Helper: set the pending Soggy Pile decision for order[index] (facilitated chain).
function pushSoggyDecision(state: GameState, cardId: string, order: string[], index: number): GameState {
  const pl = getPlayer(state, order[index])!;
  const candidates = soggyCandidates(pl);
  return {
    ...state,
    pendingDecision: {
      type: "choose_soggy_pile_discard",
      playerId: pl.id,
      cardId,
      options: candidates.map((c) => ({ cardId: c.id, cardName: c.name })),
      prompt: `${pl.name}: Choose 1 Moisture or Nitrogen card to discard from your compost pile (Soggy Pile).`,
      meta: { soggyChain: true, order, index },
    },
  };
}

function tagPendingEffectOrigin(
  state: GameState,
  actorId: string,
  originVerb: "played" | "activated" | "moved",
): GameState {
  const decision = state.pendingDecision;
  if (!decision) return state;
  return {
    ...state,
    pendingDecision: {
      ...decision,
      meta: {
        ...decision.meta,
        originActorId: decision.meta?.originActorId ?? actorId,
        ...(decision.meta?.originVerb
          ? { originVerb: decision.meta.originVerb }
          : originVerb !== "played"
            ? { originVerb }
            : {}),
      },
    },
  };
}

// Shared tail: simultaneously remove the chosen cards and hand each to the
// player on the left.
function applyWormPasses(state: GameState, passCards: Array<{ fromId: string; card: Card }>): GameState {
  let s = state;
  // Remove cards from hands
  for (const { fromId, card: passedCard } of passCards) {
    const pl = getPlayer(s, fromId)!;
    s = updatePlayer(s, { ...pl, hand: removeOneById(pl.hand, passedCard.id) });
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

  switch (getCardBaseId(card)) {
    // Anaerobic Pocket: discard 1 Airflow from compost, then choose opponent to skip
    case "anaerobic_pocket": {
      const airflowCards = p.compostPile.filter((c) => getEffectiveFunction(c) === "Airflow");
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
        .filter((pl) => pl.id !== p.id && pl.compostPile.some((c) => getEffectiveFunction(c) === "Nitrogen"))
        .map((pl) => ({
          playerId: pl.id,
          playerName: pl.name,
          cards: pl.compostPile
            .filter((c) => getEffectiveFunction(c) === "Nitrogen")
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

      // Facilitated mode: each affected player CHOOSES their own discard via a
      // sequential guided decision chain (single-candidate players auto-resolve).
      if (s.mode === "facilitated") {
        const order: string[] = [];
        for (const pl of s.players) {
          if (playerHasProtection(s, pl, "soggy_pile")) {
            addLog(s, `${pl.name} is protected from Soggy Pile!`);
            continue;
          }
          const candidates = soggyCandidates(pl);
          if (candidates.length === 0) continue;
          if (candidates.length === 1) {
            const toDiscard = candidates[0];
            s = { ...s, discardPile: [toDiscard, ...s.discardPile] };
            s = updatePlayer(s, {
              ...getPlayer(s, pl.id)!,
              compostPile: removeOneById(getPlayer(s, pl.id)!.compostPile, toDiscard.id),
            });
            addLog(s, `${pl.name} discarded ${toDiscard.name} from compost (only eligible card).`);
          } else {
            order.push(pl.id);
          }
        }
        if (order.length > 0) {
          s = pushSoggyDecision(s, card.id, order, 0);
        }
        return s;
      }

      for (const pl of s.players) {
        if (playerHasProtection(s, pl, "soggy_pile")) {
          addLog(s, `${pl.name} is protected from Soggy Pile!`);
          continue;
        }
        const candidates = soggyCandidates(pl);
        if (candidates.length > 0) {
          // Auto discard first eligible
          const toDiscard = candidates[0];
          const updated = {
            ...pl,
            compostPile: removeOneById(pl.compostPile, toDiscard.id),
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

    // Worm Party: each player chooses 1 card from hand to pass to player on left
    case "worm_party": {
      // Every player chooses their own card via a sequential decision chain.
      // Choices are applied together at the end so no one sees early transfers.
      const startIdx = s.players.findIndex((pl) => pl.id === p.id);
      const order: string[] = [];
      for (let k = 0; k < s.players.length; k++) {
        const pl = s.players[(startIdx + k) % s.players.length];
        if (pl.hand.length > 0) order.push(pl.id);
        else addLog(s, `Worm Party — ${pl.name} has no cards to pass.`);
      }
      if (order.length === 0) {
        addLog(s, `Worm Party — nobody has cards to pass.`);
        return s;
      }
      const first = getPlayer(s, order[0])!;
      s = {
        ...s,
        pendingDecision: {
          type: "choose_worm_party_card",
          playerId: first.id,
          cardId: card.id,
          options: first.hand.map((c) => ({ cardId: c.id, cardName: c.name })),
          prompt: `${first.name}: Choose 1 card from your hand to pass to the player on your left (Worm Party).`,
          meta: { wormChain: true, order, index: 0, chosen: {} },
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
  if (cardInHand.type === "hero" && !cardIs(cardInHand, "legion_of_life")) {
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

  if (cardInHand.type === "action" && state.actionPlayedThisTurn) {
    return { state, error: "You may only play one action card per turn." };
  }
  // The play cost is not an effect discard. Mark every valid play within the
  // current trace (including bot/autoresolved plays), not just the route root.
  if (cardInHand.type === "action") activeEngineOperationTrace?.playedCardIds.add(cardId);

  // Remove card from hand
  let updatedPlayer = {
    ...player,
    hand: removeOneById(player.hand, cardId),
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
      // Only offer slots that are not already occupied in this player's compost pile
      const occupiedSlots = new Set(
        getPlayer(s, player.id)!.compostPile.map((c) => getEffectiveFunction(c))
      );
      const availableFunctions = allFunctions.filter((fn) => !occupiedSlots.has(fn));
      if (availableFunctions.length === 0) {
        return { state, error: "All function slots for this card are already filled." };
      }
      if (availableFunctions.length === 1) {
        // Only one valid slot — place automatically without asking
        const cardWithChoice: Card = { ...cardInHand, chosenFunction: availableFunctions[0] };
        updatedPlayer = { ...updatedPlayer, compostPile: [...updatedPlayer.compostPile, cardWithChoice] };
        s = updatePlayer(s, updatedPlayer);
        addLog(s, `${player.name} placed ${cardInHand.name} into the ${availableFunctions[0]} slot.`);
        if (cardWithChoice.effectType === "ongoing") {
          s = recomputeAllModifiers(s);
        } else {
          s = resolveHeroInstantEffect(s, getPlayer(s, playerId)!, cardWithChoice);
        }
        s = triggerQuencher(s, playerId, cardWithChoice);
        const winner = checkWinCondition(s);
        if (winner) {
          s = { ...s, phase: "game_over", winner };
          const winnerPlayer = getPlayer(s, winner)!;
          addLog(s, `🎉 ${winnerPlayer.name} wins! They collected one hero from each function!`);
        }
        return { state: tagPendingEffectOrigin(s, player.id, "played") };
      }
      addLog(s, `${player.name} played ${cardInHand.name} — choose which function slot to fill.`);
      s = {
        ...s,
        pendingDecision: {
          type: "choose_function",
          playerId: player.id,
          cardId: cardInHand.id,
          prompt: `${player.name}: Choose which function slot to fill with ${cardInHand.name}.`,
          options: availableFunctions.map((fn) => ({ function: fn })),
          meta: { pendingCard: cardInHand as unknown as Record<string, unknown> },
        },
      };
      s = updatePlayer(s, updatedPlayer);
      return { state: tagPendingEffectOrigin(s, player.id, "played") };
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
    if (cardInHand.effectType === "ongoing") {
      // Move old ongoing action card to discard if one was active
      const prevOngoing = s.ongoingActionCard;
      s = applyOngoingModifier(s, cardInHand, player.id);
      s = {
        ...s,
        ongoingActionCard: cardInHand,
        activeModifiers: prevOngoing
          ? s.activeModifiers.filter((m) => !cardIs(prevOngoing, m.cardId))
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

  return { state: tagPendingEffectOrigin(s, player.id, "played") };
}

// ─────────────────────────────────────────────
// RESOLVE DECISION
// ─────────────────────────────────────────────
function resolveDecisionCore(
  state: GameState,
  playerId: string,
  decisionData: Record<string, unknown>
): { state: GameState; error?: string } {
  const decision = state.pendingDecision;
  if (!decision) return { state, error: "No pending decision" };
  if (decision.playerId !== playerId)
    return { state, error: "Not your decision to make" };

  let s: GameState = { ...state, pendingDecision: null };
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
        hand: removeOneById(player.hand, chosenCardId),
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
        if (hotHeadOwner.compostPile.some((c) => cardIs(c, "hot_head"))) {
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

      recordExplicitDiscardToHand(playerId, card);
      const updatedPlayer = {
        ...player,
        hand: [...player.hand, card],
      };
      s = {
        ...s,
        discardPile: removeOneById(s.discardPile, chosenCardId),
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
        compostPile: removeOneById(player.compostPile, chosenCardId),
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
          compostPile: removeOneById(targetPlayer.compostPile, card.id),
        };
        s = updatePlayer(s, updatedTarget);
        const stealToCompost = decision.meta?.stealToCompost as boolean;
        if (stealToCompost) {
          s = updatePlayer(s, {
            ...getPlayer(s, playerId)!,
            compostPile: [...getPlayer(s, playerId)!.compostPile, card],
          });
          addLog(s, `${player.name} took ${card.name} from ${targetPlayer.name}'s compost into their own compost.`);
          const winner = checkWinCondition(s);
          if (winner) {
            s = { ...s, winner, phase: "game_over" };
            addLog(s, `🎉 ${getPlayer(s, winner)!.name} wins!`);
          }
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
        compostPile: removeOneById(targetPlayer.compostPile, chosenCardId),
      });
      const stealToCompost = decision.meta?.stealToCompost as boolean;
      if (stealToCompost) {
        s = updatePlayer(s, {
          ...getPlayer(s, playerId)!,
          compostPile: [...getPlayer(s, playerId)!.compostPile, card],
        });
        addLog(s, `${player.name} took ${card.name} from ${targetPlayer.name}'s compost into their own compost.`);
        const winner = checkWinCondition(s);
        if (winner) {
          s = { ...s, winner, phase: "game_over" };
          addLog(s, `🎉 ${getPlayer(s, winner)!.name} wins!`);
        }
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
        compostPile: [...removeOneById(player.compostPile, myCardId), theirCard],
      });
      s = updatePlayer(s, {
        ...theirPlayer,
        compostPile: [...removeOneById(theirPlayer.compostPile, theirCardId), myCard],
      });
      addLog(s, `${player.name} swapped ${myCard.name} with ${theirPlayer.name}'s ${theirCard.name}.`);
      // Quencher: if the received card is Moisture, draw 1 extra card
      s = triggerQuencher(s, playerId, theirCard);
      {
        const winner = checkWinCondition(s);
        if (winner) {
          s = { ...s, winner, phase: "game_over" };
          addLog(s, `🎉 ${getPlayer(s, winner)!.name} wins!`);
        }
      }
      return { state: s };
    }

    case "choose_worm_party_card": {
      const chosenId = decisionData.cardId as string;
      const myCard = player.hand.find((c) => c.id === chosenId);
      if (!myCard) return { state, error: "Card not in hand" };

      // Facilitated sequential chain: record this player's choice, then hand
      // the decision to the next eligible player; apply all passes at the end.
      const meta = decision.meta as
        | { wormChain?: boolean; order?: string[]; index?: number; chosen?: Record<string, string> }
        | undefined;
      if (meta?.wormChain && meta.order) {
        const chosen = { ...(meta.chosen ?? {}), [playerId]: chosenId };
        const order = meta.order;
        let next = (meta.index ?? 0) + 1;
        while (next < order.length && getPlayer(s, order[next])!.hand.length === 0) next++;
        if (next < order.length) {
          const np = getPlayer(s, order[next])!;
          addLog(s, `${player.name} chose a card to pass (Worm Party).`);
          s = {
            ...s,
            pendingDecision: {
              type: "choose_worm_party_card",
              playerId: np.id,
              cardId: decision.cardId,
              options: np.hand.map((c) => ({ cardId: c.id, cardName: c.name })),
              prompt: `${np.name}: Choose 1 card from your hand to pass to the player on your left (Worm Party).`,
              meta: { wormChain: true, order, index: next, chosen },
            },
          };
          return { state: s };
        }
        s = applyWormPartyChain(s, chosen);
        return { state: s };
      }

      s = applyWormParty(s, playerId, chosenId);
      return { state: s };
    }

    case "choose_soggy_pile_discard": {
      const chosenId = decisionData.cardId as string;
      const cardInPile = player.compostPile.find((c) => c.id === chosenId);
      if (!cardInPile) return { state, error: "Card not in compost" };
      const fn = getEffectiveFunction(cardInPile);
      if (fn !== "Moisture" && fn !== "Nitrogen") {
        return { state, error: "Must discard a Moisture or Nitrogen card" };
      }
      s = { ...s, discardPile: [cardInPile, ...s.discardPile] };
      s = updatePlayer(s, {
        ...getPlayer(s, playerId)!,
        compostPile: removeOneById(getPlayer(s, playerId)!.compostPile, chosenId),
      });
      addLog(s, `${player.name} discarded ${cardInPile.name} from compost (Soggy Pile).`);

      // Facilitated sequential chain: advance to the next affected player.
      const soggyMeta = decision.meta as
        | { soggyChain?: boolean; order?: string[]; index?: number }
        | undefined;
      if (soggyMeta?.soggyChain && soggyMeta.order) {
        let next = (soggyMeta.index ?? 0) + 1;
        while (next < soggyMeta.order.length && soggyCandidates(getPlayer(s, soggyMeta.order[next])!).length === 0) {
          next++;
        }
        if (next < soggyMeta.order.length) {
          s = pushSoggyDecision(s, decision.cardId, soggyMeta.order, next);
        }
      }
      return { state: s };
    }

    case "choose_hero_from_discard": {
      const chosenCardId = decisionData.cardId as string;
      const rawCard = s.discardPile.find(
        (c) => c.id === chosenCardId && c.type === "hero"
      );
      if (!rawCard) return { state, error: "Hero not found in discard" };

      const plasticMod = s.activeModifiers.find(
        (m) => m.cardId === "plastic_contamination"
      );
      if (plasticMod) {
        return { state, error: "Plastic Contamination blocks hero placement" };
      }

      // Always clear stale chosenFunction from a previous placement
      const card: Card = { ...rawCard, chosenFunction: undefined };

      // Remove from discard first
      s = { ...s, discardPile: removeOneById(s.discardPile, chosenCardId) };

      // If card has multiple possible functions, prompt the player to choose a slot
      const allFunctions = card.alternateFunctions?.length
        ? [...new Set([card.function, ...card.alternateFunctions])]
        : [];
      if (allFunctions.length > 1) {
        // Filter out slots already occupied in this player's compost pile
        const occupiedSlots = new Set(
          getPlayer(s, playerId)!.compostPile.map((c) => getEffectiveFunction(c))
        );
        const availableFunctions = allFunctions.filter((fn) => !occupiedSlots.has(fn));
        if (availableFunctions.length === 0) {
          // No room — put the card back in discard and skip
          s = { ...s, discardPile: [card, ...s.discardPile] };
          addLog(s, `${player.name}'s compost pile has no room for ${card.name} — returned to discard.`);
          return { state: s };
        }
        addLog(s, `${player.name} chose ${card.name} from discard — select a function slot.`);
        s = {
          ...s,
          pendingDecision: {
            type: "choose_function",
            playerId,
            cardId: card.id,
            prompt: `${player.name}: Choose which function slot to fill with ${card.name} (Actinomycetes).`,
            options: availableFunctions.map((fn) => ({ function: fn })),
            meta: { pendingCard: card as unknown as Record<string, unknown> },
          },
        };
        return { state: s };
      }

      const updatedPlayer = {
        ...player,
        compostPile: [...player.compostPile, card],
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
          ...removeOneById(player.compostPile, myCardId),
          theirCard,
        ],
      };
      const updatedThem = {
        ...theirPlayer,
        compostPile: [
          ...removeOneById(theirPlayer.compostPile, theirCardId),
          myCard,
        ],
      };
      s = updatePlayer(s, updatedMe);
      s = updatePlayer(s, updatedThem);
      addLog(
        s,
        `${player.name} swapped ${myCard.name} with ${theirPlayer.name}'s ${theirCard.name}.`
      );
      // Quencher: if the received card is Moisture, draw 1 extra card
      s = triggerQuencher(s, playerId, theirCard);
      {
        const winner = checkWinCondition(s);
        if (winner) {
          s = { ...s, winner, phase: "game_over" };
          addLog(s, `🎉 ${getPlayer(s, winner)!.name} wins!`);
        }
      }
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
        hand: removeOneById(player.hand, chosenId),
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

      recordExplicitDiscardToHand(playerId, discardCard);
      const updatedPlayer = {
        ...player,
        hand: [...player.hand, discardCard],
      };
      s = {
        ...s,
        discardPile: removeOneById(s.discardPile, chosenId),
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
          hand: removeOneById(currentPlayer.hand, cid),
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
            hand: removeOneById(currentPlayer.hand, cid),
          };
          s = {
            ...s,
            discardPile: [card, ...s.discardPile],
          };

          // Hot Head check for Carbon discards (only for the player who discarded)
          if (card.function === "Carbon") {
            const hotHeadOwner = getPlayer(s, playerId)!;
            if (hotHeadOwner.compostPile.some((c) => cardIs(c, "hot_head"))) {
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
          hand: removeOneById(currentPlayer.hand, cid),
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
        hand: removeOneById(player.hand, chosenId),
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
          ...(decision.meta?.originVerb ? { meta: { originVerb: decision.meta.originVerb } } : {}),
        },
      };
      return { state: s };
    }

    // Rot & Regrow ongoing: player takes 1 card from discard pile into hand
    case "choose_rot_regrow_take": {
      const chosenId = decisionData.cardId as string;
      const card = s.discardPile.find((c) => c.id === chosenId);
      if (!card) return { state, error: "Card not found in discard pile" };

      recordExplicitDiscardToHand(playerId, card);
      const updatedPlayer = { ...player, hand: [...player.hand, card] };
      s = { ...s, discardPile: removeOneById(s.discardPile, chosenId) };
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

      // Hot Head: draw 1 card for each Carbon card discarded here
      for (const discarded of toDiscard) {
        if (discarded.function === "Carbon") {
          const currentP = getPlayer(s, playerId)!;
          if (currentP.compostPile.some((c) => cardIs(c, "hot_head"))) {
            s = drawCard(s, getPlayer(s, playerId)!);
            addLog(s, `${player.name} drew 1 card (The Hot Head — Carbon discarded).`);
          }
        }
      }

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
      // Guard: reject if the target slot is already occupied
      const alreadyOccupied = player.compostPile.some((c) => getEffectiveFunction(c) === chosenFn);
      if (alreadyOccupied) return { state, error: `The ${chosenFn} slot is already filled.` };

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

export function resolveDecision(
  state: GameState,
  playerId: string,
  decisionData: Record<string, unknown>,
): { state: GameState; error?: string } {
  const result = resolveDecisionCore(state, playerId, decisionData);
  const nextDecision = result.state.pendingDecision;
  if (result.error || !nextDecision) return result;

  // Pending choices can move from the original actor to another seat (Worm
  // Party, Soggy Pile). Carry the initiating context forward, not the resolver.
  // For legacy saved decisions, currentPlayerIndex remains the original turn
  // owner throughout the pending chain and is the safe actor fallback.
  const sourceDecision = state.pendingDecision;
  const storedOriginActorId = sourceDecision?.meta?.originActorId;
  const originActorId =
    typeof storedOriginActorId === "string" &&
    state.players.some((player) => player.id === storedOriginActorId)
      ? storedOriginActorId
      : state.players[state.currentPlayerIndex]?.id;
  const storedOriginVerb = sourceDecision?.meta?.originVerb;
  const originVerb =
    storedOriginVerb === "played" ||
    storedOriginVerb === "activated" ||
    storedOriginVerb === "moved"
      ? storedOriginVerb
      : undefined;

  return {
    ...result,
    state: {
      ...result.state,
      pendingDecision: {
        ...nextDecision,
        meta: {
          ...nextDecision.meta,
          ...(originActorId ? { originActorId } : {}),
          ...(originVerb ? { originVerb } : {}),
        },
      },
    },
  };
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
  s = { ...s, turnSequence: (s.turnSequence ?? 0) + 1 };
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
  // If the game is already over (e.g. a card play just triggered a win), do not advance.
  if (state.phase === "game_over") {
    return { state };
  }
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
        cardId: "",
        prompt: `${player.name}: Too many cards! Discard ${discardCount} card${discardCount !== 1 ? "s" : ""} (max hand: ${player.maxHandSize}).`,
        options: player.hand.map((c) => ({ cardId: c.id, cardName: c.name })),
        meta: { count: discardCount },
      },
    };
    return { state: s };
  }

  // Safety-net: check if any player already has all 5 functions before advancing
  const winner = checkWinCondition(s);
  if (winner) {
    s = { ...s, phase: "game_over", winner };
    const winnerPlayer = getPlayer(s, winner)!;
    addLog(s, `🎉 ${winnerPlayer.name} wins! They collected one hero from each function!`);
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
  mode: GameState["mode"],
  botPlayerIndices: number[] = [],
  botSkillLevels: Record<number, BotSkillLevel> = {}
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
    botSkillLevel: botPlayerIndices.includes(i)
      ? (botSkillLevels[i] ?? "medium")
      : undefined,
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

  switch (getCardBaseId(ongoing)) {
    case "hot_pile_bonus": {
      const decomposerCount = player.compostPile.filter(
        countsForHotPile
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
          meta: { count: 3, originVerb: "activated", originActorId: playerId },
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
          meta: { optional: true, originVerb: "activated", originActorId: playerId },
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
      meta: { moveCardId: cardId, originVerb: "moved", originActorId: playerId },
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
  mode: "online" | "facilitated",
  hostIsSpectator = false
): GameState {
  const host: PlayerState = {
    id: "player_0",
    name: hostName,
    hand: [],
    compostPile: [],
    skipsNextTurn: false,
    maxHandSize: 5,
    drawsExtraCard: false,
    isBot: false,
  };
  return {
    gameId,
    mode,
    phase: "waiting",
    currentPlayerIndex: 0,
    players: mode === "facilitated" && hostIsSpectator ? [] : [host],
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
    ongoingBenefitUsedThisTurn: false,
    maxPlayers,
    ...(mode === "facilitated" && hostIsSpectator ? { hostIsSpectator: true } : {}),
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

export function takeOverPlayerAsBot(
  state: GameState,
  playerId: string
): GameState {
  const playerIndex = state.players.findIndex((player) => player.id === playerId);
  if (playerIndex === -1) return state;
  const player = state.players[playerIndex];
  if (player.isBot) return state;
  const players = [...state.players];
  players[playerIndex] = {
    ...player,
    isBot: true,
    botSkillLevel: player.botSkillLevel ?? "medium",
  };
  return {
    ...state,
    players,
    log: [...state.log, `${player.name} was taken over by a bot.`],
  };
}

export function addBotToRoom(
  state: GameState,
  botName: string,
  skillLevel: BotSkillLevel = "medium"
): { state: GameState; playerIndex: number } | { state: GameState; error: string } {
  if (state.phase !== "waiting") return { state, error: "Game already started" };
  if (state.players.length >= (state.maxPlayers ?? 4)) return { state, error: "Room is full" };

  const playerIndex = state.players.length;
  const newBot: PlayerState = {
    id: `bot_${playerIndex}_${Math.random().toString(36).slice(2, 6)}`,
    name: botName,
    hand: [],
    compostPile: [],
    skipsNextTurn: false,
    maxHandSize: 5,
    drawsExtraCard: false,
    isBot: true,
    botSkillLevel: skillLevel,
  };
  return {
    state: { ...state, players: [...state.players, newBot] },
    playerIndex,
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
    id: state.mode === "facilitated" && state.hostIsSpectator === true
      ? `player_${Math.random().toString(36).slice(2, 14)}`
      : `player_${playerIndex}`,
    name: playerName,
    hand: [],
    compostPile: [],
    skipsNextTurn: false,
    maxHandSize: 5,
    drawsExtraCard: false,
    isBot: false,
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
 * ─── BOT HELPERS ────────────────────────────────────────────────────────────
 */

/** How many of the 5 WIN_FUNCTIONS does a player already have covered in their pile? */
function pileFillCount(player: PlayerState): number {
  const covered = new Set(player.compostPile.map((c) => getEffectiveFunction(c)));
  return WIN_FUNCTIONS.filter((f) => covered.has(f)).length;
}

/** Returns WIN_FUNCTIONS not yet covered by this player's compost pile */
function missingFunctions(player: PlayerState): string[] {
  const covered = new Set(player.compostPile.map((c) => getEffectiveFunction(c)));
  return WIN_FUNCTIONS.filter((f) => !covered.has(f));
}

/** Pick the opponent with the most progress (most unique WIN_FUNCTIONS in pile) */
function mostDangerousOpponent(state: GameState, selfId: string): PlayerState | null {
  const opponents = state.players.filter((p) => p.id !== selfId);
  if (opponents.length === 0) return null;
  return opponents.reduce((best, p) => pileFillCount(p) >= pileFillCount(best) ? p : best);
}

/**
 * Score how useful a card is to keep for this player (higher = keep it).
 * Used for discard decisions.
 */
function cardKeepScore(card: Card, player: PlayerState): number {
  const missing = new Set(missingFunctions(player));
  if (card.type === "hero") {
    const fns = [card.function, ...(card.alternateFunctions ?? [])];
    if (fns.some((f) => missing.has(f))) return 100;    // fills a missing slot
    if (fns.some((f) => WIN_FUNCTIONS.includes(f as any))) return 40;  // fills any hero slot (duplicate)
    return 10;
  }
  // Actions: generally worth keeping, slight preference for powerful ones
  const actionScores: Record<string, number> = {
    time_warp: 80, rainstorm: 60, high_heat_gamble: 50,
    hot_pile_bonus: 55, critical_mass: 50, nitrogen_boost: 45,
    rot_regrow: 40, carbon_sink: 45, dry_spell: 30,
    critter_raid: 25, stinky_pile: 25, pile_flip: 15,
    plastic_contamination: 20, worm_party: 20, spread_nutrients: 20,
    soggy_pile: 15, rot_roulette: 35, anaerobic_pocket: 20,
  };
  return actionScores[card.id] ?? 20;
}

/** Sort hand by ascending keep score (index 0 = best to discard first) */
function sortByDiscardFirst(cards: Card[], player: PlayerState): Card[] {
  return [...cards].sort((a, b) => cardKeepScore(a, player) - cardKeepScore(b, player));
}

/** Pick best hero from a list to fill this player's missing functions */
function pickBestHero(cards: Card[], player: PlayerState): { card: Card; chosenFn: string } | null {
  const missing = missingFunctions(player);
  let best: { card: Card; chosenFn: string } | null = null;

  for (const card of cards) {
    if (card.type !== "hero") continue;
    const validFns = [...new Set([card.function, ...(card.alternateFunctions ?? [])])];
    const matchMissing = validFns.filter((f) => missing.includes(f));
    if (matchMissing.length > 0) {
      if (!best) best = { card, chosenFn: matchMissing[0] };
      // Prefer multi-function cards that match
      if (matchMissing.length > (best ? 1 : 0)) best = { card, chosenFn: matchMissing[0] };
    }
  }
  return best;
}

/**
 * Score an action card to decide if a bot should play it.
 * Returns 0 or negative if the bot should not play it.
 */
function scoreActionCard(
  card: Card,
  state: GameState,
  player: PlayerState,
  level: BotSkillLevel
): number {
  if (card.type !== "action") return 0;

  const covered = new Set(player.compostPile.map((c) => getEffectiveFunction(c)));
  const hasMoisture = covered.has("Moisture");
  const hasNitrogen = covered.has("Nitrogen");
  const hasDecomposer = covered.has("Decomposer");
  const carbonCount = player.compostPile.filter((c) => getEffectiveFunction(c) === "Carbon").length;
  const decomposerCount = player.compostPile.filter((c) => getEffectiveFunction(c) === "Decomposer").length;
  const nitrogenInHand = player.hand.filter((c) => c.function === "Nitrogen").length;
  const handSize = player.hand.length;
  const opponents = state.players.filter((p) => p.id !== player.id);
  const danger = mostDangerousOpponent(state, player.id);

  switch (getCardBaseId(card)) {
    case "time_warp":
      return 90; // Always play — extra turn is always good

    case "rainstorm":
      return 75; // Draw 2 is nearly always worth it

    case "high_heat_gamble": {
      // Draw 3 if risk is acceptable: skip next turn if no Decomposer
      const decomposersInHand = player.hand.filter((c) => c.function === "Decomposer").length;
      if (decomposersInHand > 0) return 65;
      if (level === "hard" && pileFillCount(player) >= 3) return 20; // risky late-game
      if (level === "medium") return 40; // take the gamble
      return 0;
    }

    case "hot_pile_bonus":
      if (decomposerCount >= 2) return 70; // draws an extra card every turn
      return 0;

    case "critical_mass": {
      const pile = player.compostPile;
      const hasDoubleLayer = pile.some((c1, i) =>
        pile.some((c2, j) => j !== i && c1.layer === c2.layer && c1.layer !== null)
      );
      return hasDoubleLayer ? 60 : 0;
    }

    case "nitrogen_boost":
      return nitrogenInHand >= 1 ? 55 : 0; // discard 1 N → draw 2

    case "rot_regrow":
      // Worth it only if we have 3+ cards to discard and discard pile has useful cards
      if (handSize < 3) return 0;
      {
        const usefulInDiscard = state.discardPile.some(
          (c) => c.type === "hero" && missingFunctions(player).includes(c.function)
        );
        return usefulInDiscard ? 55 : (handSize >= 4 ? 30 : 0);
      }

    case "dry_spell":
      // Good if we have Moisture (we're immune to the hand-size penalty)
      return hasMoisture ? 45 : 0;

    case "carbon_sink":
      if (carbonCount < 2) return 0;
      {
        const opponentHasNitrogen = opponents.some((p) =>
          p.compostPile.some((c) => getEffectiveFunction(c) === "Nitrogen")
        );
        if (!opponentHasNitrogen) return 0;
        // Extra value if we need Nitrogen
        return covered.has("Nitrogen") ? 35 : 70;
      }

    case "critter_raid":
      // Discards Nitrogen from all players' hands — good if we have none at risk
      // We can't see opponents' hands, but it's likely someone has Nitrogen
      return nitrogenInHand === 0 ? 35 : 5; // hurts us less than opponents on average

    case "stinky_pile":
      // Each player discards 1 Nitrogen from compost — good if opponents have it, we don't
      {
        const oppHasNitrogen = opponents.some((p) =>
          p.compostPile.some((c) => getEffectiveFunction(c) === "Nitrogen")
        );
        if (!oppHasNitrogen) return 0;
        return hasNitrogen ? 10 : 40; // much better if it doesn't hurt us
      }

    case "soggy_pile":
      // Each player discards 1 Moisture or Nitrogen from compost
      {
        const oppCount = opponents.filter((p) =>
          p.compostPile.some((c) => {
            const fn = getEffectiveFunction(c);
            return fn === "Moisture" || fn === "Nitrogen";
          })
        ).length;
        const weGetHurt = (hasMoisture || hasNitrogen) ? 1 : 0;
        const netBenefit = oppCount - weGetHurt;
        if (level === "hard" && netBenefit > 0) return 35;
        if (level === "medium" && !hasMoisture && !hasNitrogen && oppCount > 0) return 30;
        return 0;
      }

    case "spread_nutrients":
      // Give 1 to each player, draw same back — good for cycling weak cards
      if (handSize < opponents.length + 1) return 0;
      {
        const weakCards = sortByDiscardFirst(player.hand, player).slice(0, opponents.length);
        const avgWeakScore = weakCards.reduce((s, c) => s + cardKeepScore(c, player), 0) / weakCards.length;
        return avgWeakScore < 30 ? 35 : 10;
      }

    case "worm_party":
      // Pass 1 card to left — use to pass away our least useful card
      {
        const weakest = sortByDiscardFirst(player.hand, player)[0];
        if (!weakest) return 0;
        return cardKeepScore(weakest, player) < 25 ? 30 : 5;
      }

    case "anaerobic_pocket":
      // Discard 1 Airflow from our OWN compost — very costly unless we have 2+ Airflow
      if (level !== "hard") return 0; // only hard bots consider this
      {
        const airflowCount = player.compostPile.filter((c) => getEffectiveFunction(c) === "Airflow").length;
        if (airflowCount < 2) return 0; // can't afford to lose our only Airflow
        if (!danger) return 0;
        return pileFillCount(danger) >= 4 ? 45 : 0; // only use if opponent is very close to winning
      }

    case "pile_flip":
      // All piles pass left — generally dangerous, hard bots only
      if (level !== "hard") return 0;
      {
        if (!danger) return 0;
        const ourFill = pileFillCount(player);
        const theirFill = pileFillCount(danger);
        // Only beneficial if we'd gain from the pile on our right
        const rightPlayer = state.players[(state.currentPlayerIndex + state.players.length - 1) % state.players.length];
        if (rightPlayer.id === player.id) return 0;
        const rightFill = pileFillCount(rightPlayer);
        return (theirFill > ourFill + 1 && rightFill >= ourFill) ? 40 : 0;
      }

    case "plastic_contamination":
      // Block ALL hero card play — use only when opponent is about to win
      if (level !== "hard") return 0;
      {
        if (!danger) return 0;
        return pileFillCount(danger) >= 4 ? 60 : 0;
      }

    case "rot_roulette":
      // Draw 5, discard 3, keep 2, play 1 — medium/hard only
      if (level === "easy") return 0;
      return 40;

    default:
      return 0;
  }
}

/**
 * Auto-resolve a pending decision for a bot player. Returns the new state,
 * or the same state (with decision cleared) if no valid choice can be made.
 */
function botAutoResolveDecision(state: GameState, playerId: string): GameState {
  const decision = state.pendingDecision;
  if (!decision || decision.playerId !== playerId) return state;

  const player = getPlayer(state, playerId)!;
  const missing = new Set(missingFunctions(player));
  const opts = (decision.options ?? []) as Array<Record<string, unknown>>;

  switch (decision.type) {
    // ── choose_function: multi-function hero was played, pick the function ───
    case "choose_function": {
      // Pick the function that fills a missing pile slot; otherwise first option
      const best = opts.find((o) => missing.has(o.function as string));
      const fn = best ? (best.function as string) : (opts[0]?.function as string);
      if (!fn) return state;
      const r = resolveDecision(state, playerId, { function: fn });
      return r.error ? state : r.state;
    }

    // ── choose_move_function: moving a multi-function hero to different slot ─
    case "choose_move_function": {
      const best = opts.find((o) => missing.has(o.function as string));
      const fn = best ? (best.function as string) : (opts[0]?.function as string);
      if (!fn) return state;
      const r = resolveDecision(state, playerId, { function: fn });
      return r.error ? state : r.state;
    }

    // ── choose_discard_to_limit: discard least useful cards ─────────────────
    case "choose_discard_to_limit": {
      const count = (decision.meta?.count as number) ?? 1;
      const toDiscard = sortByDiscardFirst(
        opts.map((o) => player.hand.find((c) => c.id === o.cardId)).filter(Boolean) as Card[],
        player
      ).slice(0, count);
      const r = resolveDecision(state, playerId, { cardIds: toDiscard.map((c) => c.id) });
      return r.error ? state : r.state;
    }

    // ── choose_target_player: pick opponent to skip (anaerobic_pocket) ───────
    case "choose_target_player": {
      const danger = mostDangerousOpponent(state, playerId);
      const target = danger ?? state.players.find((p) => p.id !== playerId);
      if (!target) return state;
      const r = resolveDecision(state, playerId, { targetPlayerId: target.id });
      return r.error ? state : r.state;
    }

    // ── choose_card_from_compost: discard a card from our compost ────────────
    case "choose_card_from_compost": {
      // Discard the least valuable card from our compost
      const pile = player.compostPile;
      if (pile.length === 0) return state;
      // For anaerobic_pocket: must pick Airflow, pick the one that is least missed
      const candidates = opts.map((o) => pile.find((c) => c.id === o.cardId)).filter(Boolean) as Card[];
      const toDiscard = sortByDiscardFirst(candidates, player)[0];
      if (!toDiscard) return state;
      const r = resolveDecision(state, playerId, { cardId: toDiscard.id });
      return r.error ? state : r.state;
    }

    // ── choose_card_from_discard: take a card from discard into hand ─────────
    case "choose_card_from_discard": {
      // Prefer heroes filling missing functions
      const cards = opts.map((o) => state.discardPile.find((c) => c.id === o.cardId)).filter(Boolean) as Card[];
      const best = pickBestHero(cards, player);
      const chosen = best?.card ?? cards[0];
      if (!chosen) return state;
      const r = resolveDecision(state, playerId, { cardId: chosen.id });
      return r.error ? state : r.state;
    }

    // ── choose_hero_from_discard: pick hero from discard to place in compost ─
    case "choose_hero_from_discard": {
      const heroes = opts.map((o) => state.discardPile.find((c) => c.id === o.cardId)).filter(Boolean) as Card[];
      const best = pickBestHero(heroes, player);
      const chosen = best?.card ?? heroes[0];
      if (!chosen) return state;
      const r = resolveDecision(state, playerId, { cardId: chosen.id });
      return r.error ? state : r.state;
    }

    // ── choose_opponent_for_steal: carbon_sink — pick opponent with N we need ─
    case "choose_opponent_for_steal": {
      const targets = opts as Array<{ playerId: string }>;
      if (targets.length === 0) return state;
      // Prefer to steal from the most dangerous opponent
      const danger = mostDangerousOpponent(state, playerId);
      const preferred = danger
        ? (targets.find((t) => t.playerId === danger.id) ?? targets[0])
        : targets[0];
      const r = resolveDecision(state, playerId, { targetPlayerId: preferred.playerId });
      return r.error ? state : r.state;
    }

    // ── choose_steal_card: pick which card to steal ───────────────────────────
    case "choose_steal_card": {
      const cards = opts as Array<{ cardId: string; cardName: string }>;
      if (cards.length === 0) return state;
      // Pick card filling our missing function, or first option
      const targetId = decision.meta?.targetPlayerId as string;
      const targetPlayer = getPlayer(state, targetId);
      const targetCards = targetPlayer
        ? cards.map((o) => targetPlayer.compostPile.find((c) => c.id === o.cardId)).filter(Boolean) as Card[]
        : [];
      const best = pickBestHero(targetCards, player);
      const chosen = best?.card ?? targetCards[0];
      const r = resolveDecision(state, playerId, { cardId: chosen?.id ?? cards[0].cardId });
      return r.error ? state : r.state;
    }

    // ── choose_worm_party_card: pass least useful card to the left ────────────
    case "choose_worm_party_card": {
      const cards = opts.map((o) => player.hand.find((c) => c.id === o.cardId)).filter(Boolean) as Card[];
      const toPass = sortByDiscardFirst(cards, player)[0];
      if (!toPass) return state;
      const r = resolveDecision(state, playerId, { cardId: toPass.id });
      return r.error ? state : r.state;
    }

    // ── choose_discard_for_spread: give 1 card to each other player ───────────
    case "choose_discard_for_spread": {
      const othersCount = (decision.meta?.othersIds as string[])?.length ?? 1;
      const cards = sortByDiscardFirst(player.hand, player).slice(0, othersCount);
      const cardIds = cards.map((c) => c.id);
      if (cardIds.length < othersCount) return state;
      const r = resolveDecision(state, playerId, { cardIds });
      return r.error ? state : r.state;
    }

    // ── choose_rainstorm_play: optionally play Moisture/Nitrogen to compost ───
    case "choose_rainstorm_play": {
      const eligible = opts as Array<{ cardId: string }>;
      // Play cards that fill missing pile functions
      const toPlay = eligible
        .map((o) => player.hand.find((c) => c.id === o.cardId))
        .filter((c): c is Card => !!c && missing.has(c.function));
      const r = resolveDecision(state, playerId, { cardIds: toPlay.map((c) => c.id) });
      return r.error ? state : r.state;
    }

    // ── choose_rot_roulette_keep: pick 2 best of the drawn cards ─────────────
    case "choose_rot_roulette_keep": {
      const drawn = opts as Array<{ cardId: string }>;
      const drawnCards = drawn
        .map((o) => state.players.flatMap((p) => p.hand).find((c) => c.id === o.cardId) ??
          state.deck.find((c) => c.id === o.cardId))
        .filter(Boolean) as Card[];

      // Sort by keep score (descending) and pick top 2
      const sorted = [...drawnCards].sort((a, b) => cardKeepScore(b, player) - cardKeepScore(a, player));
      const keepCardIds = sorted.slice(0, 2).map((c) => c.id);
      const finalKeepIds = keepCardIds.length >= 2 ? keepCardIds : drawn.slice(0, 2).map((o) => o.cardId);
      const r = resolveDecision(state, playerId, { keepCardIds: finalKeepIds });
      if (!r.error) {
        // Now must play 1 of the kept cards
        let s = r.state;
        if (s.pendingDecision?.type === "choose_card_from_hand") {
          s = botAutoResolveDecision(s, playerId);
        }
        return s;
      }
      return state;
    }

    // ── choose_card_from_hand: play 1 card from hand (rot roulette final step) ─
    case "choose_card_from_hand": {
      const handCards = opts
        .map((o) => player.hand.find((c) => c.id === o.cardId))
        .filter(Boolean) as Card[];
      // Prefer heroes filling missing functions
      const best = pickBestHero(handCards, player);
      const chosen = best?.card ?? handCards[0];
      if (!chosen) return state;
      const r = resolveDecision(state, playerId, { cardId: chosen.id });
      if (!r.error) {
        let s = r.state;
        // Might trigger choose_function if hero has alternate functions
        if (s.pendingDecision?.type === "choose_function") {
          s = botAutoResolveDecision(s, playerId);
        }
        return s;
      }
      return state;
    }

    // ── choose_nitrogen_boost_discard: discard 1 N from hand → draw 2 ────────
    case "choose_nitrogen_boost_discard": {
      const nCards = opts
        .map((o) => player.hand.find((c) => c.id === o.cardId))
        .filter(Boolean) as Card[];
      // Discard the least valuable Nitrogen card we have
      const toDiscard = sortByDiscardFirst(nCards, player)[0];
      if (!toDiscard) return state;
      const r = resolveDecision(state, playerId, { cardId: toDiscard.id });
      return r.error ? state : r.state;
    }

    // ── choose_rot_regrow_discard: discard 3 cards to activate rot_regrow ─────
    case "choose_rot_regrow_discard": {
      const toDiscard = sortByDiscardFirst(player.hand, player).slice(0, 3);
      if (toDiscard.length < 3) return state;
      const r = resolveDecision(state, playerId, { cardIds: toDiscard.map((c) => c.id) });
      return r.error ? state : r.state;
    }

    // ── choose_rot_regrow_take: pick 1 card from discard pile ────────────────
    case "choose_rot_regrow_take": {
      const available = opts
        .map((o) => state.discardPile.find((c) => c.id === o.cardId))
        .filter(Boolean) as Card[];
      const best = pickBestHero(available, player);
      const chosen = best?.card ?? available.find((c) => c.type === "hero") ?? available[0];
      if (!chosen) return state;
      const r = resolveDecision(state, playerId, { cardId: chosen.id });
      return r.error ? state : r.state;
    }

    // ── under-web swap: give hand card, take discard card ────────────────────
    case "choose_under_web_hand_card": {
      const toSwap = sortByDiscardFirst(player.hand, player)[0];
      if (!toSwap) return state;
      const r = resolveDecision(state, playerId, { cardId: toSwap.id });
      if (!r.error) {
        let s = r.state;
        if (s.pendingDecision?.type === "choose_under_web_discard_card") {
          s = botAutoResolveDecision(s, playerId);
        }
        return s;
      }
      return state;
    }

    case "choose_under_web_discard_card": {
      const available = opts
        .map((o) => state.discardPile.find((c) => c.id === o.cardId))
        .filter(Boolean) as Card[];
      const best = pickBestHero(available, player);
      const chosen = best?.card ?? available[0];
      if (!chosen) return state;
      const r = resolveDecision(state, playerId, { cardId: chosen.id });
      return r.error ? state : r.state;
    }

    // ── breezy swap (swap compost with opponent) ──────────────────────────────
    case "choose_swap_opponent_breezy": {
      const targets = opts as Array<{ playerId: string }>;
      const danger = mostDangerousOpponent(state, playerId);
      const preferred = danger
        ? (targets.find((t) => t.playerId === danger.id) ?? targets[0])
        : targets[0];
      const r = resolveDecision(state, playerId, { targetPlayerId: preferred.playerId });
      return r.error ? state : r.state;
    }

    case "choose_swap_their_card_breezy": {
      const theirId = decision.meta?.theirPlayerId as string;
      const them = getPlayer(state, theirId);
      if (!them) return state;
      const theirCards = opts
        .map((o) => them.compostPile.find((c) => c.id === o.cardId))
        .filter(Boolean) as Card[];
      const best = pickBestHero(theirCards, player);
      const chosen = best?.card ?? theirCards[0];
      if (!chosen) return state;
      const r = resolveDecision(state, playerId, { cardId: chosen.id });
      return r.error ? state : r.state;
    }

    case "choose_swap_my_card_breezy": {
      // Give away the duplicate function we already have covered
      const covered = new Set(player.compostPile.map((c) => getEffectiveFunction(c)));
      const myCards = opts
        .map((o) => player.compostPile.find((c) => c.id === o.cardId))
        .filter(Boolean) as Card[];
      // Find card with a function we have MORE than once (a duplicate)
      const fnCounts = new Map<string, number>();
      for (const c of player.compostPile) {
        const fn = getEffectiveFunction(c);
        fnCounts.set(fn, (fnCounts.get(fn) ?? 0) + 1);
      }
      const duplicateCard = myCards.find((c) => (fnCounts.get(getEffectiveFunction(c)) ?? 0) > 1);
      const toGive = duplicateCard ?? sortByDiscardFirst(myCards, player)[0];
      if (!toGive) return state;
      const r = resolveDecision(state, playerId, { cardId: toGive.id });
      return r.error ? state : r.state;
    }

    case "choose_compost_to_swap_breezy": {
      const myCardId = (opts[0] as any)?.myCardId as string;
      const theirCardId = (opts[0] as any)?.theirCardId as string;
      const theirPlayerId = (opts[0] as any)?.theirPlayerId as string;
      if (!myCardId || !theirCardId || !theirPlayerId) return state;
      const r = resolveDecision(state, playerId, { myCardId, theirCardId, theirPlayerId });
      return r.error ? state : r.state;
    }

    // ── card_from_opponent_compost (steal from a specific opponent) ───────────
    case "choose_card_from_opponent_compost": {
      const targetId = decision.meta?.targetPlayerId as string;
      const target = getPlayer(state, targetId);
      if (!target) return state;
      const targetCards = opts
        .map((o) => target.compostPile.find((c) => c.id === o.cardId))
        .filter(Boolean) as Card[];
      const best = pickBestHero(targetCards, player);
      const chosen = best?.card ?? targetCards[0];
      if (!chosen) return state;
      const r = resolveDecision(state, playerId, { cardId: chosen.id });
      return r.error ? state : r.state;
    }

    // ── soggy pile discard (individual player chooses which to discard) ───────
    case "choose_soggy_pile_discard": {
      const pile = player.compostPile;
      if (pile.length === 0) return state;
      const candidates = opts.map((o) => pile.find((c) => c.id === o.cardId)).filter(Boolean) as Card[];
      const toDiscard = sortByDiscardFirst(candidates, player)[0];
      if (!toDiscard) return state;
      const r = resolveDecision(state, playerId, { cardId: toDiscard.id });
      return r.error ? state : r.state;
    }

    // ── swap card to/from compost (generic) ───────────────────────────────────
    case "choose_card_to_swap_compost": {
      const candidates = opts
        .map((o) => player.compostPile.find((c) => c.id === o.cardId))
        .filter(Boolean) as Card[];
      const toSwap = sortByDiscardFirst(candidates, player)[0];
      if (!toSwap) return state;
      const r = resolveDecision(state, playerId, { cardId: toSwap.id });
      return r.error ? state : r.state;
    }

    default:
      // Unknown decision type — clear it to prevent game from getting stuck
      return { ...state, pendingDecision: null };
  }
}

/**
 * Try to activate the ongoing action card benefit for a bot. Returns new state.
 */
function botActivateOngoing(state: GameState, playerId: string): GameState {
  if (!state.ongoingActionCard) return state;
  if (state.ongoingBenefitUsedThisTurn) return state;
  if (state.pendingDecision) return state;
  if (state.phase !== "play") return state;

  const player = getPlayer(state, playerId)!;
  const ongoing = state.ongoingActionCard;

  // Check if activation is beneficial
  let shouldActivate = false;
  switch (getCardBaseId(ongoing)) {
    case "hot_pile_bonus": {
      const decomp = player.compostPile.filter(countsForHotPile).length;
      shouldActivate = decomp >= 2;
      break;
    }
    case "critical_mass": {
      const pile = player.compostPile;
      shouldActivate = pile.some((c1, i) =>
        pile.some((c2, j) => j !== i && c1.layer === c2.layer && c1.layer !== null)
      );
      break;
    }
    case "nitrogen_boost": {
      const nCount = player.hand.filter((c) => c.function === "Nitrogen").length;
      shouldActivate = nCount > 0;
      break;
    }
    case "rot_regrow": {
      shouldActivate = player.hand.length >= 3;
      break;
    }
  }

  if (!shouldActivate) return state;

  const result = activateOngoing(state, playerId);
  if (result.error) return state;
  let s = result.state;
  // Resolve any pending decision from the activation
  if (s.pendingDecision && s.pendingDecision.playerId === playerId) {
    s = botAutoResolveDecision(s, playerId);
  }
  return s;
}

/**
 * Execute a single bot turn: draw → activate ongoing → play hero → play action → end turn.
 * Difficulty levels:
 *   easy   — only plays hero cards (original behaviour)
 *   medium — also plays low-risk action cards that draw cards / give extra turns
 *   hard   — full strategic play including aggressive action cards
 */
function botTakeTurn(state: GameState, alreadyDrew = false): GameState {
  const player = state.players[state.currentPlayerIndex];
  if (!player.isBot) return state;

  const level: BotSkillLevel = player.botSkillLevel ?? "medium";

  // A takeover in the middle of a turn must continue without drawing twice.
  let s = state;
  if (!alreadyDrew) {
    s = drawCard(state, player);
    s = { ...s, phase: "play" };
    addLog(s, `${player.name} (Bot) drew a card.`);
  }

  // 2. Activate ongoing benefit early (hot_pile_bonus draws an extra card)
  s = botActivateOngoing(s, player.id);

  // 3. Find and play best hero
  const updatedPlayer = getPlayer(s, player.id)!;
  const heroChoice = pickBestHero(updatedPlayer.hand, updatedPlayer);

  if (heroChoice && !s.actionPlayedThisTurn && !s.heroPlayedThisTurn) {
    const playResult = playCard(s, player.id, heroChoice.card.id);
    if (!playResult.error) {
      s = playResult.state;
      // Resolve any pending decision from playing the hero
      let tries = 0;
      while (s.pendingDecision && s.pendingDecision.playerId === player.id && tries++ < 6) {
        s = botAutoResolveDecision(s, player.id);
      }
    }
  }

  // 4. Play the best action card (medium/hard only)
  if (level !== "easy" && !s.actionPlayedThisTurn && s.phase === "play") {
    const currentP = getPlayer(s, player.id)!;
    let bestAction: Card | null = null;
    let bestScore = 5; // threshold — must beat this to play

    for (const card of currentP.hand) {
      if (card.type !== "action") continue;
      const score = scoreActionCard(card, s, currentP, level);
      if (score > bestScore) {
        bestScore = score;
        bestAction = card;
      }
    }

    if (bestAction) {
      const playResult = playCard(s, player.id, bestAction.id);
      if (!playResult.error) {
        s = playResult.state;
        // Resolve all decisions triggered by the action
        let tries = 0;
        while (s.pendingDecision && s.pendingDecision.playerId === player.id && tries++ < 8) {
          s = botAutoResolveDecision(s, player.id);
        }
      }
    }
  }

  // 5. Activate ongoing benefit after playing cards (in case conditions changed)
  s = botActivateOngoing(s, player.id);

  // Drain any lingering decisions before ending the turn
  let drainTries = 0;
  while (s.pendingDecision && s.pendingDecision.playerId === player.id && drainTries++ < 8) {
    const before = s.pendingDecision;
    s = botAutoResolveDecision(s, player.id);
    if (s.pendingDecision === before) {
      // Stuck — clear it so endTurn can proceed
      s = { ...s, pendingDecision: null };
      break;
    }
  }

  // Leave every Worm Party chain pending for runBotTurnsIfNeeded to drain:
  // another bot may own the next step before the chain reaches a human.
  if (s.pendingDecision?.meta?.wormChain) return s;

  // 6. End turn
  const endResult = endTurn(s, player.id);
  if (!endResult.error) {
    s = endResult.state;
  } else {
    // Last-resort: clear any pending decision and retry endTurn
    if (s.pendingDecision) {
      s = { ...s, pendingDecision: null };
      const retry = endTurn(s, player.id);
      if (!retry.error) s = retry.state;
    }
  }

  return s;
}

/**
 * If there is a pendingDecision targeting a bot player, auto-resolve it.
 * This handles cases where a human action creates a decision for a bot victim
 * (e.g. Soggy Pile forcing each bot to choose a card to discard from their compost).
 * Returns the new state after resolving as many bot decisions as possible.
 */
function drainBotDecisions(state: GameState): GameState {
  let s = state;
  let tries = 0;
  while (s.pendingDecision && tries++ < 12) {
    const dec = s.pendingDecision;
    const target = s.players.find((p) => p.id === dec.playerId);
    if (!target?.isBot) break; // decision is for a human — stop
    const before = s.pendingDecision;
    s = botAutoResolveDecision(s, dec.playerId);
    // If decision didn't change we're stuck — clear it and move on
    if (s.pendingDecision === before) {
      s = { ...s, pendingDecision: null };
      break;
    }
  }
  return s;
}

export function runBotTurnsIfNeeded(state: GameState): GameState {
  // First: resolve any pending decision that targets a bot (victim decisions
  // created by a human player's action card)
  let s = drainBotDecisions(state);

  // Run bot turns in draw phase, and finish an already-started turn when the
  // current player was taken over during play.
  let iterations = 0;
  while (
    !s.pendingDecision &&
    (s.phase === "draw" || s.phase === "play" ||
      s.phase === "effect_resolution" || s.phase === "end_turn") &&
    s.players[s.currentPlayerIndex]?.isBot &&
    iterations < 20
  ) {
    s = botTakeTurn(s, s.phase !== "draw");
    // After each bot turn, drain any victim decisions targeting other bots
    s = drainBotDecisions(s);
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
