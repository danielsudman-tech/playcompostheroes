import type {
  EffectAnnouncement as GeneratedEffectAnnouncement,
  EffectEvent as GeneratedEffectEvent,
  EffectFact,
} from "@workspace/api-client-react";

export type EffectAnnouncementEvent = GeneratedEffectEvent;
export type EffectAnnouncementData = GeneratedEffectAnnouncement;

export type EffectAnnouncementLevel = "routine" | "shared" | "personal";

export interface PresentedEffectEvent {
  event: EffectAnnouncementEvent;
  text: string;
  affectsLocalPlayer: boolean;
}

function privateFactsForViewer(
  effect: EffectAnnouncementData,
  localPlayerId?: string | null,
): EffectFact[] {
  if (!localPlayerId) return [];
  const visible = (effect.privateFacts ?? []).filter((fact) => fact.playerIds.includes(localPlayerId));
  const grouped = new Map<string, EffectFact>();
  const result: EffectFact[] = [];
  for (const fact of visible) {
    if (fact.kind !== "hand_discard") {
      result.push(fact);
      continue;
    }
    const key = `${fact.actorId}:${fact.playerIds.join(",")}:${fact.kind}:${fact.function ?? ""}`;
    const previous = grouped.get(key);
    if (previous) {
      grouped.set(key, { ...previous, count: previous.count + fact.count, cardName: undefined });
    } else {
      grouped.set(key, fact);
    }
  }
  result.push(...grouped.values());
  return result;
}

function nameFor(effect: EffectAnnouncementData, playerId: string): string {
  return effect.players?.find((player) => player.id === playerId)?.name ?? "A player";
}

function subjectFor(
  effect: EffectAnnouncementData,
  playerIds: string[],
  localPlayerId?: string | null,
  excludedPlayerIds: string[] = [],
): string {
  const players = effect.players ?? [];
  if (players.length > 0 && players.every((player) => playerIds.includes(player.id))) {
    return "Everyone";
  }
  const remainingPlayers = players.filter((player) => !excludedPlayerIds.includes(player.id));
  if (
    excludedPlayerIds.length > 0 &&
    remainingPlayers.length > 0 &&
    remainingPlayers.every((player) => playerIds.includes(player.id)) &&
    playerIds.every((id) => remainingPlayers.some((player) => player.id === id))
  ) {
    return "Everyone else";
  }
  if (playerIds.length === 1) {
    return playerIds[0] === localPlayerId ? "You" : nameFor(effect, playerIds[0]);
  }
  const names = playerIds.map((id) => id === localPlayerId ? "You" : nameFor(effect, id));
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} each`;
}

function cardLabel(fact: EffectFact): string {
  return `${fact.cardName ?? "a card"}${fact.function ? ` (${fact.function})` : ""}`;
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function subjectVerb(
  effect: EffectAnnouncementData,
  playerIds: string[],
  localPlayerId: string | null | undefined,
  singularVerb: string,
  baseVerb: string,
  excludedPlayerIds: string[] = [],
): string {
  const subject = subjectFor(effect, playerIds, localPlayerId, excludedPlayerIds);
  if (subject === "Everyone" || subject === "Everyone else") return `${subject} ${singularVerb}`;
  if (playerIds.length === 1 && playerIds[0] === localPlayerId) return `You ${baseVerb}`;
  if (playerIds.length === 1) return `${subject} ${singularVerb}`;
  return `${subject} ${baseVerb}`;
}

function ownerName(
  effect: EffectAnnouncementData,
  playerId: string | undefined,
  localPlayerId: string | null | undefined,
): string {
  if (!playerId) return "A player";
  return playerId === localPlayerId ? "your" : `${nameFor(effect, playerId)}'s`;
}

function formatFact(
  effect: EffectAnnouncementData,
  fact: EffectFact,
  localPlayerId?: string | null,
): string {
  const playerIds = fact.playerIds ?? [];
  const isLocal = (playerId: string | undefined) => Boolean(playerId && playerId === localPlayerId);

  switch (fact.kind) {
    case "draw":
      return `${subjectVerb(effect, playerIds, localPlayerId, "draws", "draw")} ${countLabel(fact.count, "card")}.`;
    case "hand_discard":
      if (fact.function && playerIds.length === 1 && playerIds[0] === localPlayerId) {
        return `You discard ${countLabel(fact.count, fact.function + " card")} from your hand.`;
      }
      return `${subjectVerb(
        effect,
        playerIds,
        localPlayerId,
        "discards",
        "discard",
        privateFactsForViewer(effect, localPlayerId)
          .filter((privateFact) => privateFact.kind === "hand_discard")
          .flatMap((privateFact) => privateFact.playerIds),
      )} ${countLabel(fact.count, "card")} from hand.`;
    case "hand_loss":
      return `${subjectVerb(effect, playerIds, localPlayerId, "loses", "lose")} ${countLabel(fact.count, "card")} from hand.`;
    case "hand_transfer": {
      const sourceId = fact.sourcePlayerId ?? playerIds[0];
      const targetId = fact.targetPlayerId ?? playerIds[1];
      const count = countLabel(fact.count, "card");
      if (isLocal(sourceId)) {
        const recipient = targetId === localPlayerId ? "You" : nameFor(effect, targetId ?? "");
        return `${recipient} ${targetId === localPlayerId ? "receive" : "take"} ${count} from your hand.`;
      }
      if (isLocal(targetId)) {
        return `You receive ${count} from ${ownerName(effect, sourceId, localPlayerId)} hand.`;
      }
      return `${nameFor(effect, targetId ?? "")} receives ${count} from ${ownerName(effect, sourceId, localPlayerId)} hand.`;
    }
    case "pile_gain": {
      const ownerId = fact.targetPlayerId ?? playerIds[0];
      const subject = ownerId === localPlayerId ? "You" : nameFor(effect, ownerId ?? "");
      const verb = ownerId === localPlayerId ? "place" : "places";
      return `${subject} ${verb} ${cardLabel(fact)} in ${ownerName(effect, ownerId, localPlayerId)} compost pile.`;
    }
    case "pile_loss": {
      const ownerId = fact.sourcePlayerId ?? playerIds[0];
      const subject = ownerId === localPlayerId ? "You" : nameFor(effect, ownerId ?? "");
      const verb = ownerId === localPlayerId ? "lose" : "loses";
      return `${subject} ${verb} ${cardLabel(fact)} from ${ownerName(effect, ownerId, localPlayerId)} compost pile.`;
    }
    case "pile_transfer":
    case "compost_to_hand": {
      const sourceId = fact.sourcePlayerId ?? playerIds[0];
      const targetId = fact.targetPlayerId ?? playerIds[1];
      const card = cardLabel(fact);
      if (isLocal(sourceId)) {
        const recipient = targetId === localPlayerId ? "You" : nameFor(effect, targetId ?? "");
        return `${recipient} take${targetId === localPlayerId ? "" : "s"} ${card} from your compost pile.`;
      }
      if (isLocal(targetId)) {
        return `You take ${card} from ${ownerName(effect, sourceId, localPlayerId)} compost pile.`;
      }
      return `${nameFor(effect, targetId ?? "")} takes ${card} from ${ownerName(effect, sourceId, localPlayerId)} compost pile.`;
    }
    case "discard_to_hand": {
      const recipientId = fact.targetPlayerId ?? playerIds[playerIds.length - 1];
      const recipient = recipientId === localPlayerId ? "You" : nameFor(effect, recipientId ?? "");
      const verb = recipientId === localPlayerId ? "take" : "takes";
      return `${recipient} ${verb} ${cardLabel(fact)} from the discard pile.`;
    }
    case "skip":
      return `${subjectVerb(effect, playerIds, localPlayerId, "skips", "skip")} a turn.`;
    case "pile_shift":
      return "Everyone passes compost piles to the left.";
    case "slot_change": {
      const ownerId = fact.targetPlayerId ?? playerIds[0];
      const owner = ownerId === localPlayerId ? "your" : `${nameFor(effect, ownerId ?? "")}'s`;
      return `${ownerId === localPlayerId ? "You change" : `${nameFor(effect, ownerId ?? "")} changes`} the ${fact.cardName ?? "card"} slot in ${owner} compost pile from ${fact.previousFunction ?? "one function"} to ${fact.function ?? "another function"}.`;
    }
    case "ongoing_set":
      return fact.previousCardName
        ? `${fact.cardName ?? "A new card"} replaces ${fact.previousCardName} as the Ongoing card. It stays until another Ongoing card replaces it.`
        : `${fact.cardName ?? "A card"} is now the Ongoing card. It stays until another Ongoing card replaces it.`;
    case "ongoing_removed":
      return `${fact.cardName ?? "The Ongoing card"} was removed from play.`;
    default:
      return "";
  }
}

/** Combine identical outcomes for everyone or for all remaining public seats. */
function collapseIdenticalAllPlayerFacts(
  effect: EffectAnnouncementData,
  privateDiscardPlayerIds: string[] = [],
): EffectAnnouncementEvent[] {
  const playerIds = (effect.players ?? []).map((player) => player.id);
  const events = effect.events.flatMap((event) => {
    if (event.fact?.kind !== "hand_discard" || privateDiscardPlayerIds.length === 0) return [event];
    const publicIds = event.fact.playerIds.filter((id) => !privateDiscardPlayerIds.includes(id));
    if (publicIds.length === 0) return [];
    if (publicIds.length === event.fact.playerIds.length) return [event];
    return [{
      ...event,
      playerIds: publicIds,
      fact: { ...event.fact, playerIds: publicIds },
    }];
  });
  if (playerIds.length < 2) return events;

  const groups = new Map<string, number[]>();
  for (const [index, event] of events.entries()) {
    const fact = event.fact;
    if (!fact || !["draw", "hand_discard", "skip"].includes(fact.kind)) continue;
    const outcomePlayerIds = fact.kind === "hand_discard"
      ? playerIds.filter((id) => !privateDiscardPlayerIds.includes(id))
      : playerIds;
    const key = `${fact.kind}:${fact.count}:${outcomePlayerIds.join(",")}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  }

  const removals = new Set<number>();
  const replacements: Array<{ index: number; event: EffectAnnouncementEvent }> = [];
  for (const indices of groups.values()) {
    const facts = indices.map((index) => events[index].fact!);
    const involved = facts.flatMap((fact) => fact.playerIds);
    const outcomePlayerIds = facts[0].kind === "hand_discard"
      ? playerIds.filter((id) => !privateDiscardPlayerIds.includes(id))
      : playerIds;
    if (
      involved.length !== outcomePlayerIds.length ||
      new Set(involved).size !== outcomePlayerIds.length ||
      !outcomePlayerIds.every((id) => involved.includes(id))
    ) continue;

    const index = indices[0];
    const first = events[index];
    replacements.push({
      index,
      event: {
        ...first,
        playerIds: outcomePlayerIds,
        fact: { ...first.fact!, playerIds: outcomePlayerIds },
      },
    });
    for (const duplicate of indices.slice(1)) removals.add(duplicate);
  }

  for (const replacement of replacements) events[replacement.index] = replacement.event;
  return events.filter((_, index) => !removals.has(index));
}

export function getEffectAnnouncementHeading(
  effect: EffectAnnouncementData,
  localPlayerId?: string | null,
): string {
  const actor = effect.playedById === localPlayerId ? "You" : effect.playedByName;
  const verb = effect.verb ?? "played";
  return `${actor} ${verb} ${effect.cardName || "a card"}`;
}

/** Formats new effects only from structured facts; legacy event text is shown verbatim. */
export function getPresentedEffectEvents(
  effect: EffectAnnouncementData,
  localPlayerId?: string | null,
): PresentedEffectEvent[] {
  const scopedPrivateFacts = privateFactsForViewer(effect, localPlayerId);
  const privateDiscardPlayerIds = new Set(
    scopedPrivateFacts.filter((fact) => fact.kind === "hand_discard").flatMap((fact) => fact.playerIds),
  );
  const publicEvents = collapseIdenticalAllPlayerFacts(effect, [...privateDiscardPlayerIds]);
  const privateEvents: EffectAnnouncementEvent[] = scopedPrivateFacts.map((fact) => ({
    kind: fact.kind === "hand_discard" ? "discard" : "info",
    playerIds: fact.playerIds,
    text: "",
    fact,
  }));

  return [...publicEvents, ...privateEvents]
    .map((event) => {
      const ids = event.fact?.playerIds ?? event.playerIds ?? [];
      const allPlayers = (effect.players ?? []).length > 0 &&
        (effect.players ?? []).every((player) => ids.includes(player.id));
      const affectsLocalPlayer = Boolean(localPlayerId && ids.includes(localPlayerId));
      return {
        event,
        affectsLocalPlayer,
        allPlayers,
        text: event.fact ? formatFact(effect, event.fact, localPlayerId) || event.text : event.text,
      };
    })
    .sort((a, b) => {
      const priority = (entry: typeof a) =>
        entry.allPlayers ? 2 : entry.affectsLocalPlayer ? 0 : entry.event.fact?.playerIds?.length ? 1 : 2;
      return priority(a) - priority(b);
    })
    .map(({ event, text, affectsLocalPlayer }) => ({ event, text, affectsLocalPlayer }));
}

/** Private effect detail is returned only when the requested seat owns its hand. */
export function getPresentedPrivateFacts(
  effect: EffectAnnouncementData,
  localPlayerId?: string | null,
): string[] {
  return privateFactsForViewer(effect, localPlayerId)
    .map((fact) => formatFact(effect, fact, localPlayerId))
    .filter(Boolean);
}

export function getEffectAnnouncementLevel(
  effect: EffectAnnouncementData,
  localPlayerId?: string | null,
): EffectAnnouncementLevel {
  if (localPlayerId && effect.events.some((event) =>
    event.fact?.playerIds.includes(localPlayerId) || event.playerIds?.includes(localPlayerId)
  )) {
    return "personal";
  }
  return effect.events.length > 0 ? "shared" : "routine";
}