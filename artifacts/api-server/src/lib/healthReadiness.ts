export const DATABASE_READINESS_TIMEOUT_MS = 1_000;

export interface ReadinessClient {
  query(sql: string): Promise<unknown>;
  release(error?: Error | boolean): void;
}

export interface ReadinessPool {
  connect(): Promise<ReadinessClient>;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

const timedOut = Symbol("database-readiness-timeout");

function beforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  onTimeout: () => void,
  onLateValue?: (value: T) => void,
): Promise<T | typeof timedOut> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const expire = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        onTimeout();
      } catch {
        // Timeout still resolves as unavailable even if cleanup itself fails.
      }
      resolve(timedOut);
    };

    timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
    operation.then(
      (value) => {
        if (settled) {
          try {
            onLateValue?.(value);
          } catch {
            // Late-acquired clients must not cause an unhandled rejection.
          }
          return;
        }
        if (Date.now() >= deadline) {
          expire();
          try {
            onLateValue?.(value);
          } catch {
            // Late-acquired clients must not cause an unhandled rejection.
          }
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        if (Date.now() >= deadline) {
          expire();
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Acquires a dedicated pool client and verifies it with SELECT 1. Acquisition
 * and query share a single deadline. A client acquired after timeout is
 * immediately released, while a client with a timed-out active query is
 * destroyed rather than returned to the pool.
 */
export async function isDatabaseReady(
  pool: Pick<ReadinessPool, "connect">,
  timeoutMs = DATABASE_READINESS_TIMEOUT_MS,
): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;

  const deadline = Date.now() + timeoutMs;
  let client: ReadinessClient | undefined;
  let destroyed = false;

  try {
    const acquisition = await beforeDeadline(
      Promise.resolve().then(() => pool.connect()),
      deadline,
      () => undefined,
      (lateClient) => lateClient.release(new Error("Database readiness deadline exceeded")),
    );
    if (acquisition === timedOut) return false;
    client = acquisition;

    const probe = await beforeDeadline(
      Promise.resolve().then(() => client!.query("SELECT 1")),
      deadline,
      () => {
        destroyed = true;
        client!.release(new Error("Database readiness query timed out"));
      },
    );
    return probe !== timedOut;
  } catch {
    return false;
  } finally {
    if (client && !destroyed) {
      try {
        client.release();
      } catch {
        // A cleanup error should not escape the health endpoint.
      }
    }
  }
}