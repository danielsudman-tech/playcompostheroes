import {
  getEffectAnnouncementHeading,
  getEffectAnnouncementLevel,
  getPresentedEffectEvents,
  type EffectAnnouncementData,
} from "./effectAnnouncements";

export const GAME_UPDATES_CAP = 50;
export const PERSONAL_HIGHLIGHT_MS = 10_000;
export const SHARED_HIGHLIGHT_MS = 5_000;

export type GameUpdateTone = "effect" | "personal" | "notice" | "facilitator" | "turn";

export interface GameUpdate {
  id: string;
  /** Unique key of the source so repeats are never double-logged. */
  tone: GameUpdateTone;
  title: string;
  detail?: string;
  /** Full detail for Recap (all events and private events). */
  lines?: string[];
  at: number;
  personal: boolean;
  /** Payload signature; same id with new signature refreshes the entry. */
  sig?: string;
}

export interface GameUpdatesScope {
  gameId: string;
  seatId: string | null;
  /** Opaque per-credential id (viewerFingerprint) so a new credential resets history. */
  viewerId?: string | null;
}

export function scopeKey(scope: GameUpdatesScope): string {
  return `${scope.gameId}::${scope.viewerId ?? "local"}::${scope.seatId ?? "none"}`;
}

/** Newest first, de-duplicated by id, capped. */
export function addUpdate(list: GameUpdate[], update: GameUpdate, cap = GAME_UPDATES_CAP): GameUpdate[] {
  const existing = list.findIndex((u) => u.id === update.id);
  if (existing >= 0) {
    if (list[existing].sig === update.sig) return list;
    // Same effect, changed (e.g. private) payload: refresh in place, keep arrival time.
    const next = list.slice();
    next[existing] = { ...update, at: list[existing].at };
    return next;
  }
  return [update, ...list].slice(0, cap);
}

/** Builds an update from the received lastEffect using the shared formatters. */
export function updateFromEffect(
  effect: EffectAnnouncementData,
  localPlayerId: string | null,
  at: number
): GameUpdate {
  const level = getEffectAnnouncementLevel(effect, localPlayerId);
  const personal = level === "personal";
  const events = getPresentedEffectEvents(effect, localPlayerId);
  const lines = events.length ? events.map((e) => e.text) : effect.outcome ?? [];
  const title = personal && effect.playedById !== localPlayerId
    ? getEffectAnnouncementHeading(effect, localPlayerId)
    : `${effect.playedByName} played ${effect.cardName}`;
  return {
    id: `effect:${effect.id}`,
    tone: personal ? "personal" : "effect",
    title: personal && effect.playedById !== localPlayerId ? `${title} with ${effect.cardName}` : title,
    detail: lines.slice(0, 3).join(" / ") || undefined,
    lines: [...lines, ...(effect.privateEvents ?? [])],
    sig: effectSignature(effect),
    at,
    personal,
  };
}

export function noticeUpdate(id: string, title: string, at: number, tone: GameUpdateTone = "notice", detail?: string): GameUpdate {
  return { id, tone, title, detail, lines: detail ? [detail] : undefined, at, personal: false };
}

/** 10s for personal impact, 5s otherwise; after that the entry settles. */
export function isHighlighted(update: GameUpdate, now: number): boolean {
  const ms = update.personal ? PERSONAL_HIGHLIGHT_MS : SHARED_HIGHLIGHT_MS;
  return now - update.at < ms;
}

/** Whole viewer-serialized effect: any private/fact/verb/player-map change refreshes the entry. */
export function effectSignature(effect: EffectAnnouncementData): string {
  return JSON.stringify(effect);
}

export interface TurnSnapshot {
  turnNumber: number;
  currentPlayerId: string | null;
  phase: string;
}

/** Only active play phases produce a turn notice (never waiting or game_over). */
export function turnNoticeFor(scope: GameUpdatesScope, turn: TurnSnapshot, at: number): GameUpdate | null {
  if (!scope.seatId || turn.currentPlayerId !== scope.seatId) return null;
  if (turn.phase !== "draw" && turn.phase !== "play") return null;
  // draw -> play of the same turn shares one id, so it logs once.
  return noticeUpdate(`turn:${scopeKey(scope)}:${turn.turnNumber}`, "Your turn", at, "turn");
}
