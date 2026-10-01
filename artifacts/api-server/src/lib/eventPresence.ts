export const EVENT_PRESENCE_TIMEOUT_MS = 45_000;
export const EVENT_PRESENCE_SWEEP_INTERVAL_MS = 10_000;
export const EVENT_PRESENCE_SWEEP_OVERLAP_MS = 1_000;

function timestampMilliseconds(value: number | Date | string | null): number | null {
  if (value == null) return null;
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function isEventSeatConnected(lastSeenAt: number | Date | string | null, now = Date.now()): boolean {
  const seen = timestampMilliseconds(lastSeenAt);
  return seen !== null && now - seen <= EVENT_PRESENCE_TIMEOUT_MS;
}

export async function updateEventPresenceAndPublishTransition(
  updateLastSeen: () => Promise<number | Date | string | null | undefined>,
  publish: () => Promise<void>,
  now = Date.now(),
): Promise<boolean> {
  const previousLastSeenAt = await updateLastSeen();
  if (previousLastSeenAt === undefined) return false;
  if (isEventSeatConnected(previousLastSeenAt, now)) return false;
  await publish();
  return true;
}

export function isEventPresenceSweepCandidate(
  lastSeenAt: number | Date | string | null,
  sweepAt = Date.now(),
  lastSuccessfulSweepAt: number | null = null,
): boolean {
  const seen = timestampMilliseconds(lastSeenAt);
  if (seen === null) return false;
  if (sweepAt - seen <= EVENT_PRESENCE_TIMEOUT_MS) return false;
  if (lastSuccessfulSweepAt === null) return true;
  return seen > lastSuccessfulSweepAt - EVENT_PRESENCE_TIMEOUT_MS - EVENT_PRESENCE_SWEEP_OVERLAP_MS;
}

export class EventPresenceSweepCursor {
  private lastSuccessfulSweepAt: number | null = null;

  get watermark(): number | null {
    return this.lastSuccessfulSweepAt;
  }

  async run(sweep: (previousSuccessfulSweepAt: number | null) => Promise<number>): Promise<void> {
    const completedAt = await sweep(this.lastSuccessfulSweepAt);
    if (!Number.isFinite(completedAt)) throw new Error("Presence sweep returned an invalid timestamp");
    this.lastSuccessfulSweepAt = completedAt;
  }
}
