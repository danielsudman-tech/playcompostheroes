export interface EffectAnnouncementEvent {
  kind: "draw" | "discard" | "transfer" | "swap" | "skip" | "pile_shift" | "modifier" | "info";
  playerIds?: string[];
  text: string;
}

export interface EffectAnnouncementData {
  id: string;
  cardId: string;
  cardName: string;
  cardText: string;
  imageKey: string | null;
  playedById: string;
  playedByName: string;
  outcome: string[];
  privateEvents?: string[];
  events: EffectAnnouncementEvent[];
}

export type EffectAnnouncementLevel = "routine" | "shared" | "personal";

export interface PresentedEffectEvent {
  event: EffectAnnouncementEvent;
  text: string;
  affectsLocalPlayer: boolean;
}

export function getEffectAnnouncementHeading(
  effect: EffectAnnouncementData,
  localPlayerId?: string | null
): string {
  if (effect.playedById === localPlayerId) return "You affected yourself";
  return `${effect.playedByName} affected you`;
}

/**
 * Converts only event formats whose second-person meaning is unambiguous.
 * Hand changes remain counts; no hidden card identities are inferred.
 */
function getPersonalEventText(event: EffectAnnouncementEvent, localPlayerId: string): string {
  const { text, kind, playerIds = [] } = event;
  const localIndex = playerIds.indexOf(localPlayerId);
  if (localIndex < 0) return text;

  if (kind === "draw") {
    const match = text.match(/^.+ gained (\d+) cards?$/);
    if (match) return `You gained ${match[1]} card${match[1] === "1" ? "" : "s"}`;
  }
  if (kind === "discard") {
    const handMatch = text.match(/^.+ gave up (\d+) cards? from hand$/);
    if (handMatch) return `You gave up ${handMatch[1]} card${handMatch[1] === "1" ? "" : "s"} from your hand`;
    if (/^.+ left .+['’]s pile → discard$/.test(text)) {
      return text.replace(/ left .+['’]s pile → discard$/, " left your compost pile → discard");
    }
  }
  if (kind === "skip" && /^.+ will skip their next turn$/.test(text)) {
    return "You will skip your next turn";
  }
  if (kind === "info" && /^.+ entered .+['’]s compost pile$/.test(text)) {
    return text.replace(/ entered .+['’]s compost pile$/, " entered your compost pile");
  }
  if (kind === "transfer") {
    const moved = text.match(/^(.+) moved from .+['’]s pile to .+['’]s pile$/);
    if (moved && playerIds.length > 1) {
      return localIndex === 0
        ? `${moved[1]} moved from your compost pile to another player's pile`
        : `${moved[1]} moved from another player's pile to your compost pile`;
    }
    if (/^.+ left .+['’]s pile$/.test(text)) {
      return text.replace(/ left .+['’]s pile$/, " left your compost pile");
    }
  }
  return text;
}

export function getPresentedEffectEvents(
  effect: EffectAnnouncementData,
  localPlayerId?: string | null
): PresentedEffectEvent[] {
  return effect.events
    .map((event) => {
      const affectsLocalPlayer = Boolean(localPlayerId && event.playerIds?.includes(localPlayerId));
      return {
        event,
        affectsLocalPlayer,
        text: affectsLocalPlayer && localPlayerId ? getPersonalEventText(event, localPlayerId) : event.text,
      };
    })
    .sort((a, b) => Number(b.affectsLocalPlayer) - Number(a.affectsLocalPlayer));
}

/**
 * An event that names the local player is a direct impact, regardless of who
 * played the card. Unattributed effects are shared; effects with no event
 * details stay routine.
 */
export function getEffectAnnouncementLevel(
  effect: EffectAnnouncementData,
  localPlayerId?: string | null
): EffectAnnouncementLevel {
  if (localPlayerId && effect.events.some((event) => event.playerIds?.includes(localPlayerId))) {
    return "personal";
  }
  return effect.events.length > 0 ? "shared" : "routine";
}