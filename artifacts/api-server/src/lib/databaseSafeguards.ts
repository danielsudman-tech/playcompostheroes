export const DATABASE_CONNECTION_ACQUISITION_TIMEOUT_MS = 5_000;
export const DATABASE_ADVISORY_LOCK_TIMEOUT_MS = 2_000;
export const DATABASE_LOCK_TIMEOUT_MS = 2_000;
export const DATABASE_STATEMENT_TIMEOUT_MS = 5_000;
export const DATABASE_ACQUISITION_METRICS_CAPACITY = 2_048;

export type DatabaseSafeguardKind =
  | "connection_acquisition"
  | "advisory_lock"
  | "lock"
  | "statement";

export type MutationDisposition = "not-started" | "rolled-back" | "unknown";

export interface DatabaseSafeguardResponse {
  error: "Database temporarily unavailable";
  notApplied?: true;
}

export class DatabaseSafeguardError extends Error {
  readonly name = "DatabaseSafeguardError";
  readonly status = 503;
  readonly statusCode = 503;
  readonly code = "DATABASE_TEMPORARILY_UNAVAILABLE";
  readonly notApplied?: true;

  constructor(
    readonly kind: DatabaseSafeguardKind,
    disposition: MutationDisposition = "unknown",
  ) {
    super("Database temporarily unavailable");
    Object.setPrototypeOf(this, new.target.prototype);
    if (disposition === "not-started" || disposition === "rolled-back") {
      this.notApplied = true;
    }
  }

  toSafeResponse(): DatabaseSafeguardResponse {
    return {
      error: "Database temporarily unavailable",
      ...(this.notApplied === true ? { notApplied: true as const } : {}),
    };
  }
}

export function classifyDatabaseSafeguardError(error: unknown): DatabaseSafeguardKind | null {
  if (error instanceof DatabaseSafeguardError) return error.kind;
  if (error instanceof DatabaseAcquisitionTimeoutError) return "connection_acquisition";
  if (!error || typeof error !== "object") return null;

  const code = (error as { code?: unknown }).code;
  switch (code) {
    case "DATABASE_ACQUISITION_TIMEOUT":
    case "53300":
      return "connection_acquisition";
    case "55P03":
      return "lock";
    case "57014":
      return "statement";
    default:
      return error instanceof Error && error.message === "timeout exceeded when trying to connect"
        ? "connection_acquisition"
        : null;
  }
}

export function asDatabaseSafeguardError(
  error: unknown,
  disposition: MutationDisposition = "unknown",
): unknown {
  const kind = classifyDatabaseSafeguardError(error);
  return kind ? new DatabaseSafeguardError(kind, disposition) : error;
}

export async function acquireDatabaseClient<TClient>(
  connect: () => Promise<TClient>,
  disposition: MutationDisposition = "not-started",
): Promise<TClient> {
  try {
    return await connect();
  } catch (error) {
    throw asDatabaseSafeguardError(error, disposition);
  }
}

export interface ReleasableDatabaseClient {
  release(error?: Error | boolean): void;
}

/**
 * Release a client only after a successful advisory unlock. If unlock fails,
 * release(error) tells node-postgres to destroy the client rather than return a
 * potentially lock-owning session to the idle pool.
 */
export async function unlockThenReleaseDatabaseClient(
  client: ReleasableDatabaseClient,
  unlock: () => Promise<unknown>,
): Promise<void> {
  let unlockError: unknown;
  try {
    await unlock();
  } catch (error) {
    unlockError = error;
  }

  const destroyReason = unlockError === undefined
    ? undefined
    : unlockError instanceof Error
      ? unlockError
      : new Error("Advisory lock release failed");
  client.release(destroyReason);
  if (unlockError !== undefined) throw unlockError;
}

/** Roll back a transaction and discard the client if rollback cannot complete. */
export async function rollbackDatabaseTransaction(
  client: ReleasableDatabaseClient,
  rollback: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await rollback();
    return true;
  } catch (error) {
    const destroyReason = error instanceof Error ? error : new Error("Transaction rollback failed");
    client.release(destroyReason);
    return false;
  }
}

export class DatabaseAcquisitionTimeoutError extends Error {
  readonly name = "DatabaseAcquisitionTimeoutError";
  readonly code = "DATABASE_ACQUISITION_TIMEOUT";

  constructor() {
    super("Database temporarily unavailable");
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Bound a promise-based acquisition even when its provider does not implement
 * its own deadline. If the client arrives after the deadline, destroy it rather
 * than returning it to the pool. The acquisition promise remains observed so a
 * late rejection cannot become unhandled.
 */
export function acquireBeforeDeadline<TClient extends ReleasableDatabaseClient>(
  acquire: () => Promise<TClient>,
  timeoutMs = DATABASE_CONNECTION_ACQUISITION_TIMEOUT_MS,
): Promise<TClient> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new RangeError("Database acquisition timeout must be positive"));
  }

  return new Promise<TClient>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new DatabaseAcquisitionTimeoutError());
    }, timeoutMs);

    Promise.resolve()
      .then(acquire)
      .then(
        (client) => {
          if (settled) {
            try {
              client.release(new DatabaseAcquisitionTimeoutError());
            } catch {
              // The caller has already received the deadline error.
            }
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(client);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

export interface AcquisitionWaitStats {
  count: number;
  maxMs: number;
  p95Ms: number;
}

interface AcquisitionSample {
  completedAt: number;
  waitMs: number;
}

/**
 * Fixed-size recent history only: this keeps diagnostics bounded on a
 * long-running process and supports time-windowed admin summaries.
 */
export class RecentPoolAcquisitionMetrics {
  private readonly samples: Array<AcquisitionSample | undefined>;
  private nextIndex = 0;
  private sampleCount = 0;

  constructor(
    capacity = DATABASE_ACQUISITION_METRICS_CAPACITY,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Acquisition metrics capacity must be a positive integer");
    }
    this.samples = new Array<AcquisitionSample | undefined>(capacity);
  }

  record(startedAt: number, completedAt = this.now()): void {
    const waitMs = Number.isFinite(startedAt) && Number.isFinite(completedAt)
      ? Math.max(0, completedAt - startedAt)
      : 0;
    this.samples[this.nextIndex] = { completedAt, waitMs };
    this.nextIndex = (this.nextIndex + 1) % this.samples.length;
    this.sampleCount = Math.min(this.sampleCount + 1, this.samples.length);
  }

  snapshot(sinceMs?: number, now = this.now()): AcquisitionWaitStats {
    const cutoff = typeof sinceMs === "number" && Number.isFinite(sinceMs) && sinceMs >= 0
      ? now - sinceMs
      : Number.NEGATIVE_INFINITY;
    const values: number[] = [];
    for (let index = 0; index < this.sampleCount; index++) {
      const sample = this.samples[index];
      if (sample && sample.completedAt >= cutoff) values.push(sample.waitMs);
    }
    if (!values.length) return { count: 0, maxMs: 0, p95Ms: 0 };
    values.sort((left, right) => left - right);
    return {
      count: values.length,
      maxMs: values[values.length - 1],
      p95Ms: values[Math.max(0, Math.ceil(values.length * 0.95) - 1)],
    };
  }
}

export interface PoolConnectInstrumentable {
  connect: (...args: any[]) => any;
}

/**
 * Decorate Pool.connect without changing its callback or promise overload.
 * node-postgres Pool.query internally acquires through connect(callback), so
 * this also captures acquisitions initiated by callback-style pool.query.
 */
export function instrumentPoolAcquisitions<TPool extends PoolConnectInstrumentable>(
  pool: TPool,
  metrics: RecentPoolAcquisitionMetrics,
  now: () => number = Date.now,
): TPool {
  const originalConnect = pool.connect;
  const instrumentedConnect = function (this: unknown, ...args: any[]): any {
    const startedAt = now();
    let recorded = false;
    const recordOnce = () => {
      if (recorded) return;
      recorded = true;
      try {
        metrics.record(startedAt, now());
      } catch {
        // Instrumentation must not alter Pool.connect behavior.
      }
    };

    let callbackIndex = -1;
    for (let index = args.length - 1; index >= 0; index--) {
      if (typeof args[index] === "function") {
        callbackIndex = index;
        break;
      }
    }
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex] as (...callbackArgs: any[]) => any;
      args[callbackIndex] = function (this: unknown, ...callbackArgs: any[]): any {
        recordOnce();
        return Reflect.apply(callback, this, callbackArgs);
      };
    }

    let result: any;
    try {
      result = Reflect.apply(originalConnect, this, args);
    } catch (error) {
      recordOnce();
      throw error;
    }

    if (result && typeof result.then === "function") {
      try {
        void result.then(recordOnce, recordOnce);
      } catch {
        // An unusual thenable must retain its original result/behavior.
        recordOnce();
      }
    } else if (callbackIndex < 0) {
      recordOnce();
    }
    return result;
  };

  (pool as PoolConnectInstrumentable).connect = instrumentedConnect;
  return pool;
}

export interface AdminPoolDiagnostics {
  total: number;
  idle: number;
  waiting: number;
  acquisitionWait: AcquisitionWaitStats;
}

export function getAdminPoolDiagnostics(
  pool: { totalCount: number; idleCount: number; waitingCount: number },
  metrics: RecentPoolAcquisitionMetrics,
  sinceMs?: number,
): AdminPoolDiagnostics {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    acquisitionWait: metrics.snapshot(sinceMs),
  };
}