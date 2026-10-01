export const EVENT_PRESENCE_HEARTBEAT_INTERVAL_MS = 15_000;
export const EVENT_PRESENCE_HEARTBEAT_JITTER_MS = 3_000;
export const EVENT_PRESENCE_REQUEST_COALESCE_MS = 1_000;
export const EVENT_SAFE_RETRY_LIMIT = 2;
export const EVENT_SAFE_RETRY_BASE_DELAY_MS = 250;
export const EVENT_SAFE_RETRY_MAX_DELAY_MS = 1_000;

export type EventRetrySafety = "presence" | "ready" | "read" | "confirmed-not-applied";

interface BoundedSafeRetryOptions {
  safety: EventRetrySafety;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

function retryableStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function confirmsNotApplied(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const data = (error as { data?: unknown }).data;
  return !!data && typeof data === "object" &&
    (data as { notApplied?: unknown }).notApplied === true;
}

function mayRetryEventRequest(error: unknown, safety: EventRetrySafety): boolean {
  const status = retryableStatus(error);
  if (safety === "confirmed-not-applied") {
    return status === 503 && confirmsNotApplied(error);
  }
  if (status === 502 || status === 503 || status === 504) return true;
  // Fetch uses TypeError for network failures. Other server/API errors retain a
  // status and are deliberately not retried by this helper.
  return status === undefined && error instanceof TypeError;
}

/**
 * Bounded retry for idempotent Event readiness/presence/read requests. For
 * other requests the caller must opt in only when the server explicitly
 * confirms notApplied=true; gameplay actions must never use this helper.
 */
export async function withBoundedSafeRetry<T>(
  operation: () => Promise<T>,
  {
    safety,
    maxRetries = EVENT_SAFE_RETRY_LIMIT,
    baseDelayMs = EVENT_SAFE_RETRY_BASE_DELAY_MS,
    maxDelayMs = EVENT_SAFE_RETRY_MAX_DELAY_MS,
    random = Math.random,
    sleep = (delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
  }: BoundedSafeRetryOptions,
): Promise<T> {
  const retryLimit = Number.isFinite(maxRetries)
    ? Math.max(0, Math.min(EVENT_SAFE_RETRY_LIMIT, Math.floor(maxRetries)))
    : EVENT_SAFE_RETRY_LIMIT;
  const safeBaseDelayMs = Number.isFinite(baseDelayMs) ? Math.max(0, baseDelayMs) : EVENT_SAFE_RETRY_BASE_DELAY_MS;
  const safeMaxDelayMs = Number.isFinite(maxDelayMs) ? Math.max(0, maxDelayMs) : EVENT_SAFE_RETRY_MAX_DELAY_MS;
  let retries = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (retries >= retryLimit || !mayRetryEventRequest(error, safety)) throw error;
      const exponentialDelay = Math.min(safeMaxDelayMs, safeBaseDelayMs * 2 ** retries);
      const randomSample = random();
      const sample = Number.isFinite(randomSample) ? Math.min(1, Math.max(0, randomSample)) : 0.5;
      const delay = Math.round(exponentialDelay * (0.5 + sample * 0.5));
      retries++;
      await sleep(delay);
    }
  }
}

export function eventPresenceHeartbeatDelay(random = Math.random): number {
  const sample = Math.min(1, Math.max(0, random()));
  return Math.round(EVENT_PRESENCE_HEARTBEAT_INTERVAL_MS +
    (sample * 2 - 1) * EVENT_PRESENCE_HEARTBEAT_JITTER_MS);
}

type TimerHandle = number;

interface EventPresenceSchedulerOptions {
  send: () => Promise<unknown>;
  isVisible: () => boolean;
  schedule?: (callback: () => void, delay: number) => TimerHandle;
  cancel?: (timer: TimerHandle) => void;
  random?: () => number;
  now?: () => number;
}

export function createEventPresenceScheduler({
  send,
  isVisible,
  schedule = (callback, delay) => window.setTimeout(callback, delay),
  cancel = (timer) => window.clearTimeout(timer),
  random = Math.random,
  now = Date.now,
}: EventPresenceSchedulerOptions) {
  let stopped = false;
  let inFlight = false;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let timer: TimerHandle | null = null;

  const clearScheduled = () => {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  };

  const scheduleNext = () => {
    if (stopped || timer !== null || !isVisible()) return;
    timer = schedule(() => {
      timer = null;
      void sendOnce();
    }, eventPresenceHeartbeatDelay(random));
  };

  const sendOnce = async () => {
    if (stopped) return;
    if (!isVisible()) {
      clearScheduled();
      return;
    }
    if (inFlight) return;
    inFlight = true;
    lastSentAt = now();
    try {
      await send();
    } catch {
      // Heartbeats have no retry/backoff path; the next scheduled heartbeat is independent.
    } finally {
      inFlight = false;
      scheduleNext();
    }
  };

  const requestImmediate = () => {
    if (stopped) return;
    if (!isVisible()) {
      clearScheduled();
      return;
    }
    if (inFlight || now() - lastSentAt < EVENT_PRESENCE_REQUEST_COALESCE_MS) return;
    clearScheduled();
    void sendOnce();
  };

  void sendOnce();
  return {
    requestImmediate,
    stop: () => {
      stopped = true;
      clearScheduled();
    },
  };
}
