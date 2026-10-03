/** Pure queue for staged bot-turn announcements. Never gates controls; display only. */
export interface BotTurnUpdate {
  id: string;
  playerId: string;
  playerName: string;
  cardName?: string;
  summary: string;
  /** Optional public removal line for the same play. */
  removalLine?: string;
  ts: number;
}
export const BOT_UPDATE_GAP_MS = 1500;
const SEEN_CAP = 200;

export interface BotQueueState {
  seen: string[];
  queue: BotTurnUpdate[];
  lastReleaseAt: number | null;
  primed: boolean;
}
export const emptyBotQueue = (): BotQueueState => ({ seen: [], queue: [], lastReleaseAt: null, primed: false });

/**
 * First snapshot is baseline history (shown immediately, never replayed slowly).
 * Later snapshots queue only unseen ids, chronologically. Repeated state is a no-op.
 */
export function ingestBotUpdates(state: BotQueueState, incoming: BotTurnUpdate[] | null | undefined):
  { state: BotQueueState; immediate: BotTurnUpdate[] } {
  const list = [...(incoming ?? [])].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  const known = new Set(state.seen);
  const fresh: BotTurnUpdate[] = [];
  for (const u of list) {
    if (known.has(u.id)) continue;
    known.add(u.id);
    fresh.push(u);
  }
  if (!state.primed) {
    if (incoming == null) return { state, immediate: [] };
    return { state: { ...state, primed: true, seen: [...known].slice(-SEEN_CAP) }, immediate: fresh };
  }
  if (!fresh.length) return { state, immediate: [] };
  return { state: { ...state, seen: [...known].slice(-SEEN_CAP), queue: [...state.queue, ...fresh] }, immediate: [] };
}

/** Releases at most one update when the gap since the last release has elapsed. */
export function releaseDue(state: BotQueueState, now: number, gap = BOT_UPDATE_GAP_MS):
  { state: BotQueueState; released: BotTurnUpdate | null } {
  if (!state.queue.length) return { state, released: null };
  if (state.lastReleaseAt != null && now - state.lastReleaseAt < gap) return { state, released: null };
  const [head, ...rest] = state.queue;
  return { state: { ...state, queue: rest, lastReleaseAt: now }, released: head };
}

/** ms until the next queue action is due, or null when nothing is waiting. */
export function nextWakeMs(state: BotQueueState, now: number, gap = BOT_UPDATE_GAP_MS): number | null {
  if (!state.queue.length) return null;
  return state.lastReleaseAt == null ? 0 : Math.max(0, gap - (now - state.lastReleaseAt));
}

/** "Your turn" cue waits for the queue to drain plus one gap after the last bot update. null = not yet. */
export function turnCueDelay(state: BotQueueState, now: number, gap = BOT_UPDATE_GAP_MS): number | null {
  if (state.queue.length) return null;
  return state.lastReleaseAt == null ? 0 : Math.max(0, gap - (now - state.lastReleaseAt));
}
