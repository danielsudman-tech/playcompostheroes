import assert from "node:assert/strict";
import {
  DATABASE_ADVISORY_LOCK_TIMEOUT_MS,
  DATABASE_CONNECTION_ACQUISITION_TIMEOUT_MS,
  DATABASE_LOCK_TIMEOUT_MS,
  DATABASE_STATEMENT_TIMEOUT_MS,
  DatabaseAcquisitionTimeoutError,
  DatabaseSafeguardError,
  RecentPoolAcquisitionMetrics,
  acquireBeforeDeadline,
  asDatabaseSafeguardError,
  classifyDatabaseSafeguardError,
  getAdminPoolDiagnostics,
  instrumentPoolAcquisitions,
  rollbackDatabaseTransaction,
  type PoolConnectInstrumentable,
  unlockThenReleaseDatabaseClient,
} from "../lib/databaseSafeguards.js";

assert.equal(DATABASE_CONNECTION_ACQUISITION_TIMEOUT_MS, 5_000);
assert.equal(DATABASE_ADVISORY_LOCK_TIMEOUT_MS, 2_000);
assert.equal(DATABASE_LOCK_TIMEOUT_MS, 2_000);
assert.equal(DATABASE_STATEMENT_TIMEOUT_MS, 5_000);

const beforeMutation = new DatabaseSafeguardError("advisory_lock", "not-started");
assert.equal(beforeMutation.status, 503);
assert.deepEqual(beforeMutation.toSafeResponse(), {
  error: "Database temporarily unavailable",
  notApplied: true,
});
const afterRollback = new DatabaseSafeguardError("statement", "rolled-back");
assert.equal(afterRollback.toSafeResponse().notApplied, true);
const ambiguousOutcome = new DatabaseSafeguardError("statement");
assert.deepEqual(ambiguousOutcome.toSafeResponse(), {
  error: "Database temporarily unavailable",
});
assert.equal(ambiguousOutcome.notApplied, undefined, "ambiguous mutation outcome never claims notApplied");
assert.equal(
  classifyDatabaseSafeguardError({ code: "55P03", detail: "private SQL detail" }),
  "lock",
);
assert.equal(classifyDatabaseSafeguardError({ code: "57014", query: "private query" }), "statement");
assert.equal(classifyDatabaseSafeguardError({ code: "42P01" }), null);
const wrappedLockTimeout = asDatabaseSafeguardError({ code: "55P03" }, "not-started") as DatabaseSafeguardError;
assert.equal(wrappedLockTimeout.kind, "lock");
assert.equal(wrappedLockTimeout.toSafeResponse().notApplied, true,
  "lock-acquisition timeout before mutation is safe to retry");
const rolledBackStatementTimeout = asDatabaseSafeguardError(
  { code: "57014", query: "private query" },
  "rolled-back",
) as DatabaseSafeguardError;
assert.equal(rolledBackStatementTimeout.kind, "statement");
assert.equal(rolledBackStatementTimeout.toSafeResponse().notApplied, true,
  "statement timeout is retryable only after explicit transaction rollback");
const unknownStatementOutcome = asDatabaseSafeguardError(
  { code: "57014" },
  "unknown",
) as DatabaseSafeguardError;
assert.equal(unknownStatementOutcome.toSafeResponse().notApplied, undefined);
assert.equal(
  JSON.stringify(ambiguousOutcome.toSafeResponse()).includes("private"),
  false,
  "safe error response does not leak SQL or database error detail",
);

let failedUnlockReleaseError: Error | boolean | undefined;
const unlockFailure = new Error("private advisory unlock detail");
await assert.rejects(unlockThenReleaseDatabaseClient({
  release: (error) => { failedUnlockReleaseError = error; },
}, async () => { throw unlockFailure; }), unlockFailure);
assert.equal(failedUnlockReleaseError, unlockFailure,
  "failed advisory unlock destroys the client instead of returning it to the pool");

let failedRollbackReleaseError: Error | boolean | undefined;
const rollbackFailure = new Error("private rollback detail");
assert.equal(await rollbackDatabaseTransaction({
  release: (error) => { failedRollbackReleaseError = error; },
}, async () => { throw rollbackFailure; }), false);
assert.equal(failedRollbackReleaseError, rollbackFailure,
  "failed transaction rollback destroys its client");

type TestDatabaseClient = { release: (error?: Error | boolean) => void };
let resolveLateAcquisition!: (client: TestDatabaseClient) => void;
let lateClientDestroyReason: Error | boolean | undefined;
const lateAcquisition = acquireBeforeDeadline(
  () => new Promise<TestDatabaseClient>((resolve) => { resolveLateAcquisition = resolve; }),
  10,
);
await assert.rejects(lateAcquisition, DatabaseAcquisitionTimeoutError);
resolveLateAcquisition({
  release: (error) => { lateClientDestroyReason = error; },
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(lateClientDestroyReason instanceof DatabaseAcquisitionTimeoutError,
  "a client acquired after the deadline is destroyed instead of returned idle");

process.env.DATABASE_URL ||= "postgres://safeguards-test:safeguards-test@127.0.0.1:1/safeguards";
const { withClientTransaction, releaseGameMutationLockSafely } = await import("../lib/gameStore.js");
let middlewareClientDestroyReason: Error | boolean | undefined;
const cleanupFailure = Object.assign(new Error("secret SQL and connection details"), { code: "XX000" });
const cleanupLogEntries: string[] = [];
await releaseGameMutationLockSafely({
  query: async () => { throw cleanupFailure; },
  release: (error) => { middlewareClientDestroyReason = error; },
}, "game-test", (entry) => cleanupLogEntries.push(entry));
assert.equal(middlewareClientDestroyReason, cleanupFailure,
  "middleware cleanup failure destroys the advisory-lock client");
assert.equal(cleanupLogEntries.length, 1, "middleware cleanup failure is logged");
assert.deepEqual(JSON.parse(cleanupLogEntries[0]), {
  level: "error",
  event: "game_mutation_lock_release_failed",
  errorName: "Error",
  errorCode: "XX000",
});
assert.equal(cleanupLogEntries[0].includes("secret"), false,
  "middleware cleanup logging excludes SQL and connection details");
for (const timeoutCode of ["55P03", "57014"]) {
  const statements: string[] = [];
  const timeoutClient = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.startsWith("UPDATE ")) {
        throw Object.assign(new Error("private database statement"), { code: timeoutCode });
      }
      return { rows: [] };
    },
    release: () => undefined,
  };
  await assert.rejects(
    withClientTransaction(timeoutClient, () => timeoutClient.query("UPDATE timeout_test")),
    (error: unknown) => error instanceof DatabaseSafeguardError &&
      error.status === 503 && error.toSafeResponse().notApplied === true,
    "lock/statement timeout is marked notApplied only after the transaction rolls back",
  );
  assert.deepEqual(statements, ["BEGIN", "UPDATE timeout_test", "ROLLBACK"]);

  const recovered = await withClientTransaction({
    query: async () => ({ rows: [] }),
    release: () => undefined,
  }, async () => "recovered");
  assert.equal(recovered, "recovered", "a successful transaction can proceed after a timeout rollback");
}

let clock = 100;
const ring = new RecentPoolAcquisitionMetrics(3, () => clock);
ring.record(0, 100);
ring.record(98, 101);
ring.record(96, 104);
ring.record(104, 105);
assert.deepEqual(ring.snapshot(undefined, 105), {
  count: 3,
  maxMs: 8,
  p95Ms: 8,
});
assert.deepEqual(ring.snapshot(2, 105), {
  count: 2,
  maxMs: 8,
  p95Ms: 8,
}, "sinceMs filters by completion timestamp");
assert.deepEqual(ring.snapshot(0, 105), { count: 1, maxMs: 1, p95Ms: 1 });

const promiseMetrics = new RecentPoolAcquisitionMetrics(8, () => clock);
const promiseClient = { release: () => undefined };
const promiseConnectResult = Promise.resolve(promiseClient);
const promisePool: PoolConnectInstrumentable = {
  connect: () => promiseConnectResult,
};
instrumentPoolAcquisitions(promisePool, promiseMetrics, () => clock);
assert.equal(promisePool.connect(), promiseConnectResult,
  "promise connect overload returns the original promise unchanged");
await promiseConnectResult;
assert.deepEqual(promiseMetrics.snapshot(), { count: 1, maxMs: 0, p95Ms: 0 });

let callbackCompleted!: () => void;
const callbackMetrics = new RecentPoolAcquisitionMetrics(8, () => clock);
const callbackClient = { release: () => undefined };
const callbackPool: PoolConnectInstrumentable = {
  connect(callback: (error: Error | null, client: typeof callbackClient, release: () => void) => void) {
    setTimeout(() => {
      clock += 7;
      callback(null, callbackClient, () => undefined);
    }, 0);
    return "callback-overload-return";
  },
};
instrumentPoolAcquisitions(callbackPool, callbackMetrics, () => clock);
assert.equal(
  callbackPool.connect((error: Error | null, client: typeof callbackClient, release: () => void) => {
    assert.equal(error, null);
    assert.equal(client, callbackClient);
    release();
    callbackCompleted();
  }),
  "callback-overload-return",
  "callback connect overload return value remains unchanged",
);
await new Promise<void>((resolve) => { callbackCompleted = resolve; });
assert.deepEqual(callbackMetrics.snapshot(), { count: 1, maxMs: 7, p95Ms: 7 });

const queryMetrics = new RecentPoolAcquisitionMetrics(8, () => clock);
const queryPool: PoolConnectInstrumentable & {
  query: (callback: (error: Error | null, result?: string) => void) => unknown;
} = {
  connect(callback: (error: Error | null, client: typeof callbackClient, release: () => void) => void) {
    setTimeout(() => {
      clock += 3;
      callback(null, callbackClient, () => undefined);
    }, 0);
    return undefined;
  },
  query(this: PoolConnectInstrumentable, callback: (error: Error | null, result?: string) => void) {
    return this.connect((error: Error | null) => callback(error, "queried"));
  },
};
instrumentPoolAcquisitions(queryPool, queryMetrics, () => clock);
await new Promise<void>((resolve, reject) => {
  queryPool.query((error, result) => {
    try {
      assert.equal(error, null);
      assert.equal(result, "queried");
      resolve();
    } catch (assertionError) {
      reject(assertionError);
    }
  });
});
assert.deepEqual(queryMetrics.snapshot(), { count: 1, maxMs: 3, p95Ms: 3 },
  "Pool.query callback-style internal connect acquisitions are measured");

const diagnostics = getAdminPoolDiagnostics(
  { totalCount: 10, idleCount: 8, waitingCount: 2 },
  queryMetrics,
);
assert.deepEqual(diagnostics, {
  total: 10,
  idle: 8,
  waiting: 2,
  acquisitionWait: { count: 1, maxMs: 3, p95Ms: 3 },
});