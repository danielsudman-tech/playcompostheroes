import { getCardById, type Card } from "./cards.js";
import type { GameState, PlayerState, EffectAnnouncement, EffectEvent } from "./gameEngine.js";

let _effectCounter = 0;

/**
 * Resolve a card instance id to its Card, searching every zone of both the
 * before and after states (hands, compost piles, discard, deck, ongoing card).
 * Decision chains often move the originating card between zones before the
 * chain finishes, so a single-zone lookup would frequently miss it. As a last
 * resort, fall back to the base card definition (instance ids are `${baseId}__N`).
 */
export function findEffectCard(before: GameState, after: GameState, cardId: string | null | undefined): Card | null {
  if (!cardId) return null;
  for (const state of [before, after]) {
    for (const p of state.players) {
      const hit = p.hand.find((c) => c.id === cardId) ?? p.compostPile.find((c) => c.id === cardId);
      if (hit) return hit;
    }
    const other =
      state.discardPile.find((c) => c.id === cardId) ??
      state.deck.find((c) => c.id === cardId) ??
      (state.ongoingActionCard?.id === cardId ? state.ongoingActionCard : null);
    if (other) return other;
  }
  return getCardById(cardId.split("__")[0]) ?? null;
}

function pileCardKeys(p: PlayerState): Set<string> {
  return new Set(p.compostPile.map((c) => c.id));
}

/**
 * Builds a rich, spectator-safe effect announcement for facilitated mode by
 * diffing the game state before/after an action and collecting new log lines.
 * Never reveals hidden hand contents — only counts and public pile/discard moves.
 */
export function buildEffectAnnouncement(
  before: GameState,
  after: GameState,
  card: Card | null,
  actorId: string
): EffectAnnouncement | null {
  const actor = before.players.find((p) => p.id === actorId);
  if (!actor) return null;

  // New log entries = plain-language outcome
  // (log is capped at 50 entries, so compare from the tail of the common prefix)
  const beforeLog = before.log;
  const afterLog = after.log;
  let common = 0;
  while (common < beforeLog.length && common < afterLog.length && beforeLog[common] === afterLog[common]) common++;
  const outcome = afterLog.slice(common);

  const events: EffectEvent[] = [];

  // Per-player diffs (hand counts + pile contents — pile contents are public)
  for (const pBefore of before.players) {
    const pAfter = after.players.find((p) => p.id === pBefore.id);
    if (!pAfter) continue;

    const handDelta = pAfter.hand.length - pBefore.hand.length;
    if (handDelta > 0) {
      events.push({ kind: "draw", playerIds: [pBefore.id], text: `${pBefore.name} gained ${handDelta} card${handDelta > 1 ? "s" : ""}` });
    } else if (handDelta < 0) {
      events.push({ kind: "discard", playerIds: [pBefore.id], text: `${pBefore.name} gave up ${-handDelta} card${handDelta < -1 ? "s" : ""} from hand` });
    }

    const beforeKeys = pileCardKeys(pBefore);
    const afterKeys = pileCardKeys(pAfter);
    const lost = pBefore.compostPile.filter((c) => !afterKeys.has(c.id));
    const gained = pAfter.compostPile.filter((c) => !beforeKeys.has(c.id));

    for (const c of gained) {
      // Did it come from another player's pile? → transfer
      const fromPlayer = before.players.find(
        (op) => op.id !== pBefore.id && op.compostPile.some((oc) => oc.id === c.id)
      );
      if (fromPlayer) {
        events.push({
          kind: "transfer",
          playerIds: [fromPlayer.id, pBefore.id],
          text: `${c.name} moved from ${fromPlayer.name}'s pile to ${pBefore.name}'s pile`,
        });
      } else {
        events.push({ kind: "info", playerIds: [pBefore.id], text: `${c.name} entered ${pBefore.name}'s compost pile` });
      }
    }
    for (const c of lost) {
      const stillInSomeonesPile = after.players.some((op) => op.compostPile.some((oc) => oc.id === c.id));
      const inDiscard = after.discardPile.some((dc) => dc.id === c.id);
      if (!stillInSomeonesPile && inDiscard) {
        events.push({ kind: "discard", playerIds: [pBefore.id], text: `${c.name} left ${pBefore.name}'s pile → discard` });
      } else if (!stillInSomeonesPile && !inDiscard) {
        events.push({ kind: "transfer", playerIds: [pBefore.id], text: `${c.name} left ${pBefore.name}'s pile` });
      }
      // transfers into other piles are already reported on the gaining side
    }

    if (!pBefore.skipsNextTurn && pAfter.skipsNextTurn) {
      events.push({ kind: "skip", playerIds: [pBefore.id], text: `${pBefore.name} will skip their next turn` });
    }
  }

  // Whole-pile rotation (Pile Flip): many transfers at once
  const transferCount = events.filter((e) => e.kind === "transfer").length;
  if (transferCount >= before.players.length && card && (card.baseId ?? card.id).startsWith("pile_flip")) {
    events.unshift({ kind: "pile_shift", text: "All compost piles passed to the left!" });
  }

  // Ongoing/modifier changes
  const beforeOngoing = before.ongoingActionCard?.id ?? null;
  const afterOngoing = after.ongoingActionCard?.id ?? null;
  if (beforeOngoing !== afterOngoing) {
    if (after.ongoingActionCard) {
      events.push({ kind: "modifier", text: `${after.ongoingActionCard.name} is now the Ongoing Action` });
    } else if (before.ongoingActionCard) {
      events.push({ kind: "modifier", text: `${before.ongoingActionCard.name} was removed from play` });
    }
  }

  return {
    id: `fx_${Date.now()}_${++_effectCounter}`,
    cardId: card ? (card.baseId ?? card.id) : "",
    cardName: card?.name ?? "Effect",
    cardText: card?.cardText ?? "",
    imageKey: card?.imageKey ?? null,
    playedById: actor.id,
    playedByName: actor.name,
    outcome,
    events,
  };
}
