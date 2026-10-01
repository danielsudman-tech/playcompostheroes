import { getCardById, type Card } from "./cards.js";
import type {
  EngineOperationTrace,
  EffectAnnouncement,
  EffectEvent,
  EffectFact,
  GameState,
  PlayerState,
} from "./gameEngine.js";

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

/** Removes all private maps and returns only this seat's private card details. */
export function serializeEffectAnnouncement(
  effect: EffectAnnouncement | null | undefined,
  viewerId?: string,
  isOnline = true,
): EffectAnnouncement | null | undefined {
  if (!effect) return effect;
  const {
    privateEventsByPlayerId,
    privateFactsByPlayerId,
    privateEvents: _unscopedPrivateEvents,
    privateFacts: _unscopedPrivateFacts,
    trustedExplicitDiscardToHand,
    ...publicEffect
  } = effect;
  const trustsExplicitDiscardPicks = trustedExplicitDiscardToHand === true;
  return {
    ...publicEffect,
    outcome: (publicEffect.outcome ?? []).map((line) =>
      isLegacyAmbiguousDiscardGain(line) ? GENERIC_DISCARD_GAIN : line
    ),
    events: (publicEffect.events ?? []).map((event) =>
      sanitizePublicEffectEvent(event, trustsExplicitDiscardPicks)
    ),
    privateEvents: isOnline && viewerId ? privateEventsByPlayerId?.[viewerId] ?? [] : [],
    privateFacts: isOnline && viewerId ? privateFactsByPlayerId?.[viewerId] ?? [] : [],
  };
}

const HAND_DERIVED_FACTS = new Set<EffectFact["kind"]>([
  "draw",
  "hand_discard",
  "hand_transfer",
  "hand_loss",
  "discard_to_hand",
]);

const DISCARD_TO_HAND_TEXT = /\b(?:from\s+(?:the\s+)?discard(?:\s+pile)?|discard(?:\s+pile)?\s+to\s+(?:their\s+|your\s+|the\s+)?hand)\b/i;
const DISCARD_TO_HAND_ACTION = /\b(?:take|took|takes|select|selected|selects|pick|picked|picks|choose|chose|chooses|gain|gained|gains|receive|received|return|returned|retrieve|retrieved|add|added|put|placed|move|moved|went|draw|drew)\b/i;
const GENERIC_DISCARD_GAIN = "A player gained cards.";

function isLegacyAmbiguousDiscardGain(text: string): boolean {
  return DISCARD_TO_HAND_TEXT.test(text) && DISCARD_TO_HAND_ACTION.test(text);
}

function sanitizePublicEffectEvent(
  event: EffectEvent,
  trustsExplicitDiscardPicks: boolean,
): EffectEvent {
  const isTrustedNamedPick = trustsExplicitDiscardPicks && event.fact?.kind === "discard_to_hand";
  if (
    (event.fact?.kind === "discard_to_hand" && !isTrustedNamedPick) ||
    (!isTrustedNamedPick && isLegacyAmbiguousDiscardGain(event.text))
  ) {
    // Old saved announcements did not distinguish explicit selection from a
    // random reshuffle. Remove the affected-seat identity as well as the card.
    return { kind: "info", text: GENERIC_DISCARD_GAIN };
  }

  if (
    !event.fact ||
    !HAND_DERIVED_FACTS.has(event.fact.kind) ||
    (event.fact.kind === "discard_to_hand" && isTrustedNamedPick)
  ) return event;
  const { cardName: _hiddenCardName, function: _hiddenFunction, ...safeFact } = event.fact;
  return { ...event, fact: safeFact };
}

function baseId(card: Card): string {
  return card.baseId ?? card.id.split("__", 1)[0] ?? card.id;
}

function publicFunction(card: Card): string {
  return card.chosenFunction ?? card.function;
}

function pileOwners(players: PlayerState[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const player of players) {
    for (const card of player.compostPile) owners.set(card.id, player.id);
  }
  return owners;
}

/**
 * Builds a spectator-safe effect announcement from the actual card-instance
 * transitions. Public text keeps its legacy shape for in-progress saved games;
 * structured facts let new clients use plain language without parsing that text.
 */
export function buildEffectAnnouncement(
  before: GameState,
  after: GameState,
  card: Card | null,
  actorId: string,
  verb: NonNullable<EffectAnnouncement["verb"]> = "played",
  operations?: EngineOperationTrace,
): EffectAnnouncement | null {
  const actor = before.players.find((p) => p.id === actorId);
  if (!actor) return null;

  const events: EffectEvent[] = [];
  const privateEventsByPlayerId: Record<string, string[]> = {};
  const privateFactsByPlayerId: Record<string, EffectFact[]> = {};
  const afterHandOwners = new Map<string, string>();
  const beforeHandOwners = new Map<string, string>();
  const beforeDeckIds = new Set(before.deck.map((c) => c.id));
  const beforeDiscardCards = new Map(before.discardPile.map((c) => [c.id, c]));
  const beforePileCards = new Map(before.players.flatMap((p) => p.compostPile.map((c) => [c.id, c] as const)));
  const afterPileOwners = pileOwners(after.players);
  const beforePileOwners = pileOwners(before.players);
  const afterDiscardIds = new Set(after.discardPile.map((c) => c.id));
  const afterOngoingId = after.ongoingActionCard?.id;

  for (const player of before.players) {
    for (const held of player.hand) {
      beforeHandOwners.set(held.id, player.id);
    }
  }
  for (const player of after.players) {
    for (const held of player.hand) afterHandOwners.set(held.id, player.id);
  }

  const addEvent = (
    eventKind: EffectEvent["kind"],
    factKind: EffectFact["kind"],
    playerIds: string[],
    count: number,
    text: string,
    details: Partial<Pick<EffectFact,
      "cardName" | "function" | "previousFunction" | "previousCardName" | "sourcePlayerId" | "targetPlayerId">> = {},
  ) => {
    events.push({
      kind: eventKind,
      playerIds,
      text,
      fact: { kind: factKind, actorId, playerIds, count, ...details },
    });
  };

  // The played card itself is a cost, not a hand outcome. Track losses and
  // gains by instance id so simultaneous discards and draws do not cancel out.
  for (const pBefore of before.players) {
    const pAfter = after.players.find((p) => p.id === pBefore.id);
    if (!pAfter) continue;

    const playedFromActorHand =
      pBefore.id === actorId &&
      card !== null &&
      pBefore.hand.some((held) => held.id === card.id) &&
      !pAfter.hand.some((held) => held.id === card.id);

    const lostFromHand = pBefore.hand.filter((held) =>
      !pAfter.hand.some((remaining) => remaining.id === held.id) &&
      !(playedFromActorHand && held.id === card?.id),
    );

    const sentCardsByPlayer = new Map<string, Card[]>();
    const discardedFromHandById = new Map<string, Card>();
    for (const held of lostFromHand) {
      if (afterDiscardIds.has(held.id)) discardedFromHandById.set(held.id, held);
    }
    for (const operation of operations?.handDiscards ?? []) {
      if (operation.playerId === pBefore.id) {
        discardedFromHandById.set(operation.card.id, operation.card);
      }
    }
    const discardedFromHand = [...discardedFromHandById.values()];
    let otherHandLossCount = 0;
    for (const held of lostFromHand) {
      const recipientId = afterHandOwners.get(held.id);
      if (recipientId && recipientId !== pBefore.id) {
        const sent = sentCardsByPlayer.get(recipientId) ?? [];
        sent.push(held);
        sentCardsByPlayer.set(recipientId, sent);
      } else if (afterDiscardIds.has(held.id) || discardedFromHandById.has(held.id)) {
        // Counted below, including transient discards seen only in the trace.
      } else if (
        !afterPileOwners.has(held.id) &&
        afterOngoingId !== held.id &&
        !after.players.some((p) => p.hand.some((other) => other.id === held.id))
      ) {
        // A removed card whose destination is no longer represented in the
        // public state is reported as a loss, never named or guessed to be a
        // discard.
        otherHandLossCount += 1;
      }
    }

    for (const [recipientId, sent] of sentCardsByPlayer) {
      const recipient = before.players.find((p) => p.id === recipientId) ?? after.players.find((p) => p.id === recipientId);
      const names = before.players.concat(after.players).find((p) => p.id === pBefore.id);
      addEvent(
        "transfer",
        "hand_transfer",
        [pBefore.id, recipientId],
        sent.length,
        `${names?.name ?? pBefore.name} gave ${sent.length} card${sent.length === 1 ? "" : "s"} to ${recipient?.name ?? "another player"}`,
        { sourcePlayerId: pBefore.id, targetPlayerId: recipientId },
      );
    }

    if (discardedFromHand.length > 0) {
      addEvent(
        "discard",
        "hand_discard",
        [pBefore.id],
        discardedFromHand.length,
        `${pBefore.name} gave up ${discardedFromHand.length} card${discardedFromHand.length === 1 ? "" : "s"} from hand`,
      );
      privateFactsByPlayerId[pBefore.id] = [
        ...(privateFactsByPlayerId[pBefore.id] ?? []),
        ...discardedFromHand.map((discarded) => ({
          kind: "hand_discard" as const,
          actorId,
          playerIds: [pBefore.id],
          count: 1,
          cardName: discarded.name,
          function: publicFunction(discarded),
        })),
      ];
      privateEventsByPlayerId[pBefore.id] = [
        ...(privateEventsByPlayerId[pBefore.id] ?? []),
        ...discardedFromHand.map((discarded) => {
          const fn = publicFunction(discarded);
          return `${discarded.name}${fn ? ` (${fn})` : ""} was discarded from your hand`;
        }),
      ];
    }

    if (otherHandLossCount > 0) {
      addEvent(
        "discard",
        "hand_loss",
        [pBefore.id],
        otherHandLossCount,
        `${pBefore.name} lost ${otherHandLossCount} card${otherHandLossCount === 1 ? "" : "s"} from hand`,
      );
    }

    const tracedDraws = (operations?.draws ?? []).filter((draw) => draw.playerId === pBefore.id);
    const tracedDrawCardIds = new Set(tracedDraws.flatMap((draw) => draw.cardIds));
    const handAdded = pAfter.hand.filter((held) => !beforeHandOwners.has(held.id));
    let drawCount = tracedDraws.reduce((sum, draw) => sum + draw.cardIds.length, 0);
    let untracedDiscardGainCount = 0;
    for (const held of handAdded) {
      if (tracedDrawCardIds.has(held.id)) continue;
      if (beforeDeckIds.has(held.id)) {
        drawCount += 1;
        continue;
      }

      const explicitDiscardPick = (operations?.discardToHand ?? []).find(
        (pick) => pick.playerId === pBefore.id && pick.card.id === held.id,
      );
      if (explicitDiscardPick) {
        const cardFromDiscard = beforeDiscardCards.get(held.id) ?? explicitDiscardPick.card;
        addEvent(
          "info",
          "discard_to_hand",
          [pBefore.id],
          1,
          `${pAfter.name} took ${cardFromDiscard.name} from discard`,
          { cardName: cardFromDiscard.name, function: publicFunction(cardFromDiscard), targetPlayerId: pBefore.id },
        );
        continue;
      }

      const cardFromDiscard = beforeDiscardCards.get(held.id);
      if (cardFromDiscard) {
        // Without explicit-choice provenance this may be a random reshuffle.
        // Never name it as a selected card, even for legacy state-diff callers.
        untracedDiscardGainCount += 1;
        continue;
      }

      const cardFromPile = beforePileCards.get(held.id);
      const sourcePlayerId = beforePileOwners.get(held.id);
      if (cardFromPile && sourcePlayerId) {
        addEvent(
          "transfer",
          "compost_to_hand",
          [sourcePlayerId, pBefore.id],
          1,
          `${pAfter.name} took ${cardFromPile.name} from ${before.players.find((p) => p.id === sourcePlayerId)?.name ?? "a player's"} pile`,
          {
            cardName: cardFromPile.name,
            function: publicFunction(cardFromPile),
            sourcePlayerId,
            targetPlayerId: pBefore.id,
          },
        );
      }
      // Incoming cards previously held by another player are reported once as
      // a hand transfer by their owner, not as a draw by the recipient.
    }
    if (untracedDiscardGainCount > 0) {
      events.push({
        kind: "info",
        playerIds: [pBefore.id],
        text: `${pAfter.name} gained ${untracedDiscardGainCount} card${untracedDiscardGainCount === 1 ? "" : "s"}.`,
      });
    }
    if (drawCount > 0) {
      addEvent("draw", "draw", [pBefore.id], drawCount, `${pAfter.name} gained ${drawCount} card${drawCount === 1 ? "" : "s"}`);
    }
  }

  // Compost piles are face-up. Names and chosen functions are public even
  // after a card leaves its former pile.
  for (const pBefore of before.players) {
    const pAfter = after.players.find((p) => p.id === pBefore.id);
    if (!pAfter) continue;
    const beforeKeys = new Set(pBefore.compostPile.map((c) => c.id));
    const afterKeys = new Set(pAfter.compostPile.map((c) => c.id));
    const gained = pAfter.compostPile.filter((c) => !beforeKeys.has(c.id));
    const lost = pBefore.compostPile.filter((c) => !afterKeys.has(c.id));

    for (const c of gained) {
      const sourcePlayerId = beforePileOwners.get(c.id);
      if (sourcePlayerId && sourcePlayerId !== pBefore.id) {
        const source = before.players.find((p) => p.id === sourcePlayerId);
        addEvent(
          "transfer",
          "pile_transfer",
          [sourcePlayerId, pBefore.id],
          1,
          `${c.name} moved from ${source?.name ?? "another player's"} pile to ${pBefore.name}'s pile`,
          {
            cardName: c.name,
            function: publicFunction(c),
            sourcePlayerId,
            targetPlayerId: pBefore.id,
          },
        );
      } else {
        addEvent(
          "info",
          "pile_gain",
          [pBefore.id],
          1,
          `${c.name} entered ${pBefore.name}'s compost pile`,
          { cardName: c.name, function: publicFunction(c), targetPlayerId: pBefore.id },
        );
      }
    }

    for (const c of lost) {
      if (afterPileOwners.has(c.id) || afterHandOwners.has(c.id)) continue;
      const inDiscard = afterDiscardIds.has(c.id);
      addEvent(
        inDiscard ? "discard" : "transfer",
        "pile_loss",
        [pBefore.id],
        1,
        inDiscard
          ? `${c.name} left ${pBefore.name}'s pile → discard`
          : `${c.name} left ${pBefore.name}'s pile`,
        { cardName: c.name, function: publicFunction(c), sourcePlayerId: pBefore.id },
      );
    }

    // Function-slot moves keep the same instance in the pile, so they are not
    // visible in its added/removed-ID sets.
    for (const beforeCard of pBefore.compostPile) {
      const afterCard = pAfter.compostPile.find((c) => c.id === beforeCard.id);
      if (!afterCard) continue;
      const previousFunction = publicFunction(beforeCard);
      const nextFunction = publicFunction(afterCard);
      if (previousFunction !== nextFunction) {
        addEvent(
          "info",
          "slot_change",
          [pBefore.id],
          1,
          `${beforeCard.name} moved from ${previousFunction} to ${nextFunction} in ${pBefore.name}'s compost pile`,
          {
            cardName: afterCard.name,
            function: nextFunction,
            previousFunction,
            targetPlayerId: pBefore.id,
          },
        );
      }
    }

    if (!pBefore.skipsNextTurn && pAfter.skipsNextTurn) {
      addEvent("skip", "skip", [pBefore.id], 1, `${pBefore.name} will skip their next turn`);
    }
  }

  // Whole-pile rotation (Pile Flip) is one outcome; individual transfers are
  // retained for old clients, while the structured fact avoids duplicate copy.
  const transferCount = events.filter((e) => e.fact?.kind === "pile_transfer").length;
  if (transferCount >= before.players.length && card && baseId(card).startsWith("pile_flip")) {
    events.unshift({
      kind: "pile_shift",
      text: "All compost piles passed to the left!",
      fact: {
        kind: "pile_shift",
        actorId,
        playerIds: before.players.map((player) => player.id),
        count: 1,
      },
    });
  }

  const beforeOngoing = before.ongoingActionCard;
  const afterOngoing = after.ongoingActionCard;
  if (beforeOngoing?.id !== afterOngoing?.id) {
    if (afterOngoing) {
      addEvent(
        "modifier",
        "ongoing_set",
        [],
        1,
        `${afterOngoing.name} is now the Ongoing Action`,
        { cardName: afterOngoing.name, previousCardName: beforeOngoing?.name },
      );
    } else if (beforeOngoing) {
      addEvent(
        "modifier",
        "ongoing_removed",
        [],
        1,
        `${beforeOngoing.name} was removed from play`,
        { cardName: beforeOngoing.name },
      );
    }
  }

  const announcement: EffectAnnouncement = {
    id: `fx_${Date.now()}_${++_effectCounter}`,
    cardId: card ? baseId(card) : "",
    cardName: card?.name ?? "Effect",
    cardText: card?.cardText ?? "",
    imageKey: card?.imageKey ?? null,
    playedById: actor.id,
    playedByName: actor.name,
    verb,
    players: before.players.map(({ id, name }) => ({ id, name })),
    outcome: [],
    events,
    privateEventsByPlayerId,
    privateFactsByPlayerId,
  };
  if (events.some((event) => event.fact?.kind === "discard_to_hand")) {
    announcement.trustedExplicitDiscardToHand = true;
  }
  return announcement;
}