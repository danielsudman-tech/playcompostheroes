export const EVENT_PRESENCE_HEARTBEAT_INTERVAL_MS = 15_000;
export const EVENT_PRESENCE_HEARTBEAT_JITTER_MS = 3_000;
export const EVENT_PRESENCE_REQUEST_COALESCE_MS = 1_000;

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
