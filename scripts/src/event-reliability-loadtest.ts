import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { runCompleteScenario } from "./event-reliability-final-scenario.js";
import {
  observeDashboardChange,
  openHostEventFeed,
  percentile,
  PoolDiagnosticsSampler,
  readPoolDiagnostics,
  resolveFixtureManifestPath,
  settlePoolAfterBurst,
  type DashboardObservation,
  type HostEventFeed,
  type OperationResult,
  type PoolCheckpoint,
  type PoolExhaustionIncident,
  type PoolSample,
  type RequestOptions,
} from "./event-reliability-support.js";

type QueryResult<Row> = { rows: Row[]; rowCount?: number | null };
type MonitorPool = {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>;
  end(): Promise<void>;
};
type PgRuntime = {
  Pool: new (options: {
    connectionString: string;
    max: number;
    application_name: string;
    connectionTimeoutMillis: number;
    statement_timeout: number;
  }) => MonitorPool;
};
type JsonRecord = Record<string, unknown>;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = resolve(SCRIPT_DIR, "..");
const RESULTS_DIR = resolve(SCRIPTS_ROOT, "results");
const DEFAULT_API_BASE = "http://localhost:80/api";
const RUN_PREFIX = "DEV-LOADTEST";

// pg is already installed for @workspace/db. Resolve it from that workspace
// package so this script can also be used before pnpm has relinked scripts deps.
const requireFromDb = createRequire(resolve(SCRIPTS_ROOT, "../lib/db/src/index.ts"));
const { Pool } = requireFromDb("pg") as PgRuntime;

type ScenarioName = "A" | "B";
type Table = { gameId: string; tableNumber: number; capacity: number };
type Seat = {
  token: string;
  playerId: string;
  playerName: string;
  gameId: string;
  tableNumber: number;
};
type FixtureEvent = {
  scenario: ScenarioName;
  name: string;
  eventId: string | null;
  gameIds: string[];
};
type FixtureManifest = {
  format: 1;
  runId: string;
  facilitatorId: string | null;
  events: FixtureEvent[];
  createdAt: string;
};
type DbSample = {
  sampledAt: string;
  connections: number;
  active: number;
  lockWaiters: number;
  idleInTransaction: number;
  longestActiveSeconds: number;
};

class HttpFailure extends Error {
  constructor(readonly status: number, readonly operation: string) {
    super(`${operation} returned HTTP ${status}`);
  }
}

class DeadlineFailure extends Error {
  constructor() {
    super("Overall test deadline reached");
  }
}

function parseArgs(argv: string[]): Map<string, string | boolean> {
  const options = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "help") {
      options.set(key, true);
      continue;
    }
    if (key === "confirm-development-database") {
      options.set(key, true);
      continue;
    }
    if (key === "staging-vm") {
      options.set(key, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    options.set(key, value);
    index += 1;
  }
  return options;
}

function requiredOption(options: Map<string, string | boolean>, key: string): string {
  const value = options.get(key);
  if (typeof value !== "string" || !value) throw new Error(`Required option: --${key}`);
  return value;
}

function apiBaseFromEnvironment(options: Map<string, string | boolean>): URL {
  const raw = process.env.API_BASE_URL ?? DEFAULT_API_BASE;
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("API_BASE_URL must not contain credentials, a query string, or a fragment");
  }
  const host = url.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const isReplitDev = host.endsWith(".replit.dev");
  if (options.get("staging-vm") === true && !isLoopback) {
    throw new Error("--staging-vm requires an explicit loopback API_BASE_URL");
  }
  if (!isLoopback && !isReplitDev) {
    throw new Error("API_BASE_URL must be localhost or an allowlisted *.replit.dev development host (published hosts are refused)");
  }
  if (isLoopback && url.port && url.port !== "80") {
    throw new Error("Loopback API_BASE_URL must use the shared proxy on port 80");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API_BASE_URL must use HTTP or HTTPS");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/api")) url.pathname += "/api";
  return url;
}

function validateDevelopmentEnvironment(apiBase: URL, options: Map<string, string | boolean>): void {
  if (options.get("confirm-development-database") !== true) {
    throw new Error("Refusing to run without --confirm-development-database");
  }
  if (process.env.NODE_ENV !== "development") {
    throw new Error("NODE_ENV must be exactly 'development'");
  }
  const stagingVmOptIn = options.get("staging-vm") === true;
  if (process.env.REPLIT_DEPLOYMENT && !stagingVmOptIn) {
    throw new Error("REPLIT_DEPLOYMENT is set; only an explicitly guarded staging VM may run this harness");
  }
  if (stagingVmOptIn) {
    if (!process.env.REPLIT_DEPLOYMENT || process.env.APP_ENV !== "staging" ||
        process.env.STAGING_VM_LOADTEST !== "1") {
      throw new Error("--staging-vm requires a staging deployment with APP_ENV=staging and STAGING_VM_LOADTEST=1");
    }
    if (!["localhost", "127.0.0.1", "::1"].includes(apiBase.hostname.toLowerCase()) ||
        (apiBase.port && apiBase.port !== "80")) {
      throw new Error("Staging VM requests must use the local shared proxy; published targets are refused");
    }
  }
  if (/^(prod|production)$/i.test(process.env.APP_ENV ?? "")) {
    throw new Error("APP_ENV indicates production");
  }
  if (!process.env.APP_PASSWORD) throw new Error("APP_PASSWORD is required for legitimate admin facilitator approval");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the read-only development database monitor");

  const parsedDatabaseUrl = new URL(databaseUrl);
  const databaseIdentity = `${parsedDatabaseUrl.hostname}/${parsedDatabaseUrl.pathname}`.toLowerCase();
  if (/(^|[/_.-])(prod|production|live|primary)([/_.-]|$)/i.test(databaseIdentity)) {
    throw new Error("DATABASE_URL appears to identify a production/live database");
  }
  if (apiBase.hostname.endsWith(".replit.app") || apiBase.hostname.endsWith(".repl.co")) {
    throw new Error("Published application domains are refused");
  }
}

function makeDeadline(seconds: number): AbortSignal {
  return AbortSignal.timeout(seconds * 1000);
}

function combineSignals(deadline: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([deadline, AbortSignal.timeout(timeoutMs)]);
}

function isTimeout(error: unknown): boolean {
  if (error instanceof DeadlineFailure) return true;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return true;
  return false;
}

function createMonitor(): {
  pool: MonitorPool;
  sample: () => Promise<DbSample>;
  validate: () => Promise<{ database: string; serverVersion: string }>;
} {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    max: 1,
    application_name: "dev-event-reliability-monitor",
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  return {
    pool,
    async validate() {
      const result = await pool.query<{ database: string; server_version: string }>(
        `SELECT current_database() AS database, current_setting('server_version') AS server_version`,
      );
      const row = result.rows[0];
      if (!row) throw new Error("Development database monitor returned no identity");
      if (/(^|[/_.-])(prod|production|live|primary)([/_.-]|$)/i.test(row.database)) {
        throw new Error("Connected database name appears to identify a production/live database");
      }
      return { database: row.database, serverVersion: row.server_version };
    },
    async sample() {
      const result = await pool.query<{
        connections: number | string;
        active: number | string;
        lock_waiters: number | string;
        idle_in_transaction: number | string;
        longest_active_seconds: number | string | null;
      }>(`
        SELECT
          COUNT(*)::int AS connections,
          COUNT(*) FILTER (WHERE state = 'active')::int AS active,
          COUNT(*) FILTER (WHERE wait_event_type = 'Lock')::int AS lock_waiters,
          COUNT(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_transaction,
          COALESCE(MAX(EXTRACT(EPOCH FROM NOW() - query_start))
            FILTER (WHERE state = 'active'), 0)::float AS longest_active_seconds
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
      `);
      const row = result.rows[0];
      if (!row) throw new Error("Development database monitor sample returned no row");
      return {
        sampledAt: new Date().toISOString(),
        connections: Number(row.connections),
        active: Number(row.active),
        lockWaiters: Number(row.lock_waiters),
        idleInTransaction: Number(row.idle_in_transaction),
        longestActiveSeconds: Number(row.longest_active_seconds ?? 0),
      };
    },
  };
}

async function runMonitor(
  monitor: ReturnType<typeof createMonitor>,
  signal: AbortSignal,
  samples: DbSample[],
  sampleErrors: string[],
): Promise<void> {
  while (!signal.aborted) {
    try {
      samples.push(await monitor.sample());
    } catch (error) {
      sampleErrors.push(error instanceof Error ? error.name : "Unknown monitor error");
    }
    if (signal.aborted) break;
    await new Promise<void>((resolveDelay) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolveDelay();
      };
      const timer = setTimeout(finish, 1000);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}

class LoadTest {
  readonly apiBase: URL;
  readonly deadline: AbortSignal;
  readonly timeoutMs: number;
  readonly results: OperationResult[] = [];
  readonly dbSamples: DbSample[] = [];
  readonly monitorErrors: string[] = [];
  readonly failed: string[] = [];
  readonly dashboardObservations: DashboardObservation[] = [];
  readonly poolCheckpoints: PoolCheckpoint[] = [];
  readonly poolSamples: PoolSample[] = [];
  readonly poolExhaustionIncidents: PoolExhaustionIncident[] = [];
  readonly poolSamplingErrors: Array<{ phase: string; sampledAt: string; error: string }> = [];
  readonly assertions: string[] = [];
  readonly manifest: FixtureManifest;
  readonly reportPath: string;
  readonly manifestPath: string;
  readonly adminPassword: string;
  readonly monitor: ReturnType<typeof createMonitor>;
  readonly poolSampler: PoolDiagnosticsSampler;
  readonly runStartedAtMs: number;
  readonly expectedGuestSeats: number;
  readonly runId: string;
  userToken = "";
  eventId = "";
  eventCode = "";
  hostTokens: Record<string, string> = {};
  seats: Seat[] = [];
  tables: Table[] = [];
  hostFeed?: HostEventFeed;
  finalScenario?: JsonRecord;
  failureMessage: string | null = null;

  constructor(
    apiBase: URL,
    scenario: ScenarioName,
    deadlineSeconds: number,
    timeoutMs: number,
  ) {
    const runId = randomUUID();
    this.runId = runId;
    this.apiBase = apiBase;
    this.deadline = makeDeadline(deadlineSeconds);
    this.timeoutMs = timeoutMs;
    this.adminPassword = process.env.APP_PASSWORD!;
    this.runStartedAtMs = Date.now();
    this.expectedGuestSeats = scenario === "A" ? 16 : 32;
    this.monitor = createMonitor();
    this.poolSampler = new PoolDiagnosticsSampler(this);
    const eventName = `${RUN_PREFIX} ${runId} scenario-${scenario}`;
    this.manifest = {
      format: 1,
      runId,
      facilitatorId: null,
      events: [{ scenario, name: eventName, eventId: null, gameIds: [] }],
      createdAt: new Date().toISOString(),
    };
    this.manifestPath = resolve(RESULTS_DIR, `event-reliability-${runId}.fixtures.json`);
    this.reportPath = resolve(RESULTS_DIR, `event-reliability-${runId}.report.json`);
  }

  async saveManifest(): Promise<void> {
    await mkdir(RESULTS_DIR, { recursive: true });
    await writeFile(this.manifestPath, `${JSON.stringify(this.manifest, null, 2)}\n`, { mode: 0o600 });
  }

  async request<T>(
    operation: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<{ data: T; status: number; response: Response }> {
    if (this.deadline.aborted) throw new DeadlineFailure();
    const startedAt = performance.now();
    const headers = new Headers();
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.admin) headers.set("x-admin-key", this.adminPassword);
    if (options.bearer) headers.set("authorization", `Bearer ${options.bearer}`);
    let status: number | null = null;
    try {
      const response = await fetch(new URL(path.replace(/^\/+/, ""), `${this.apiBase.href}/`), {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: combineSignals(this.deadline, this.timeoutMs),
        cache: "no-store",
      });
      status = response.status;
      if (options.stream) {
        const reader = response.body?.getReader();
        if (!reader) throw new Error("SSE response has no body");
        const first = await reader.read();
        await reader.cancel().catch(() => undefined);
        if (!response.ok) throw new HttpFailure(response.status, operation);
        if (first.done || !new TextDecoder().decode(first.value).includes("data:")) {
          throw new Error("SSE stream did not deliver its initial event");
        }
        const durationMs = performance.now() - startedAt;
        this.results.push({ operation, phase: options.phase ?? "setup", durationMs, status, outcome: "ok" });
        return { data: undefined as T, status, response };
      }
      const text = await response.text();
      let data: unknown = undefined;
      if (text) {
        try {
          data = JSON.parse(text) as unknown;
        } catch {
          data = undefined;
        }
      }
      if (!response.ok) throw new HttpFailure(response.status, operation);
      const durationMs = performance.now() - startedAt;
      this.results.push({ operation, phase: options.phase ?? "setup", durationMs, status, outcome: "ok" });
      return { data: data as T, status, response };
    } catch (error) {
      const outcome = isTimeout(error) ? "timeout" : error instanceof HttpFailure ? "http_error" : "error";
      this.results.push({
        operation,
        phase: options.phase ?? "setup",
        durationMs: performance.now() - startedAt,
        status,
        outcome,
      });
      this.failed.push(operation);
      throw error;
    }
  }

  async allSettled<T>(operation: string, work: Array<() => Promise<T>>): Promise<T[]> {
    const settled = await Promise.allSettled(work.map((item) => item()));
    const failures = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failures.length) {
      throw new Error(`${operation}: ${failures.length}/${settled.length} requests failed or timed out`);
    }
    return settled.map((item) => (item as PromiseFulfilledResult<T>).value);
  }

  async createFacilitator(): Promise<void> {
    const runId = this.manifest.runId;
    const email = `dev-event-${runId}@example.test`;
    const password = randomBytes(24).toString("base64url");
    const registered = await this.request<{ token: string; user: { id: string } }>(
      "register-facilitator",
      "auth/register",
      {
        method: "POST",
        body: {
          email,
          name: `${RUN_PREFIX} facilitator ${runId}`,
          organization: "Development-only load test",
          password,
        },
      },
    );
    this.userToken = registered.data.token;
    this.manifest.facilitatorId = registered.data.user.id;
    await this.saveManifest();
    await this.request("approve-facilitator", `admin/users/${encodeURIComponent(registered.data.user.id)}/facilitator`, {
      method: "PATCH",
      admin: true,
      body: { approved: true },
    });
  }

  async createEvent(scenario: ScenarioName): Promise<void> {
    const eventFixture = this.manifest.events[0];
    const guestCount = scenario === "A" ? 16 : 32;
    const tableCount = scenario === "A" ? 4 : 8;
    const created = await this.request<{
      eventId: string;
      code: string;
      tables: Array<{ gameId: string; tableNumber: number; capacity: number }>;
      hostTokens: Record<string, string>;
    }>("create-event", "facilitator/events", {
      method: "POST",
      body: {
        userToken: this.userToken,
        name: eventFixture.name,
        tableCount,
        tableCapacities: Array(tableCount).fill(4),
        idleSeconds: 3600,
        assignmentMode: "auto",
      },
    });
    this.eventId = created.data.eventId;
    this.eventCode = created.data.code;
    this.hostTokens = created.data.hostTokens;
    this.tables = created.data.tables.map((table) => ({
      gameId: table.gameId,
      tableNumber: table.tableNumber,
      capacity: table.capacity,
    }));
    eventFixture.eventId = this.eventId;
    eventFixture.gameIds = this.tables.map((table) => table.gameId);
    await this.saveManifest();

    const feed = await openHostEventFeed(this, "host-sse-open-before-joins");
    this.hostFeed = feed;
    await readPoolDiagnostics(this, "pool-before-join-burst", this.runStartedAtMs);
    const joinSinceMs = Date.now();
    this.poolSampler.setPhase("join-burst", joinSinceMs, "burst");
    const joinSequence = feed.lastSequence;
    const joinStartedAt = performance.now();
    const joins = Array.from({ length: guestCount }, (_, index) => async () => {
      const joined = await this.request<{
        token: string;
        playerId: string;
        playerName: string;
        gameId: string;
        tableNumber: number;
      }>(`join-${index + 1}`, `events/${encodeURIComponent(this.eventCode)}/join`, {
        method: "POST",
        body: { name: `DEV guest ${String(index + 1).padStart(2, "0")}` },
        phase: "burst",
      });
      const seat = joined.data;
      this.seats.push({
        token: seat.token,
        playerId: seat.playerId,
        playerName: seat.playerName,
        gameId: seat.gameId,
        tableNumber: seat.tableNumber,
      });
      return seat;
    });
    await this.allSettled("join burst", joins);
    await observeDashboardChange(
      this,
      feed,
      "join-burst",
      joinStartedAt,
      joinSequence,
      (detail) => detail.tables.reduce((sum, table) => sum + table.players.length, 0) === guestCount,
    );
    await settlePoolAfterBurst(this, "join-burst", joinSinceMs);
  }

  async reorganizeWaitingGuests(): Promise<void> {
    const restructuringSinceMs = Date.now();
    this.poolSampler.setPhase("waiting-room-reorganization", restructuringSinceMs, "burst");
    const guestCounts = this.tables.map((table) => ({
      table,
      seats: this.seats.filter((seat) => seat.gameId === table.gameId),
    }));
    const nonEmpty = guestCounts.filter(({ seats }) => seats.length > 0);
    const fullestBeforeChanges = [...nonEmpty].sort((a, b) => b.seats.length - a.seats.length)[0];
    if (!fullestBeforeChanges) throw new Error("Fixture did not populate enough event tables");

    const reorderSeats = fullestBeforeChanges.seats.map((seat) => seat.playerId).reverse();
    await this.request("waiting-reorder", `games/${fullestBeforeChanges.table.gameId}/waiting/reorder`, {
      method: "POST",
      body: {
        token: this.hostTokens[fullestBeforeChanges.table.gameId],
        userToken: this.userToken,
        playerIds: reorderSeats,
      },
      phase: "burst",
    });

    const kickCandidate = fullestBeforeChanges.seats[0];
    if (!kickCandidate) throw new Error("No safe synthetic guest available for the kick fixture");
    await this.request("waiting-kick", `games/${kickCandidate.gameId}/players/${encodeURIComponent(kickCandidate.playerId)}`, {
      method: "DELETE",
      body: {
        token: this.hostTokens[kickCandidate.gameId],
        userToken: this.userToken,
      },
      phase: "burst",
    });
    this.seats = this.seats.filter((seat) => seat.playerId !== kickCandidate.playerId);

    const afterKick = this.tables.map((table) => ({
      table,
      seats: this.seats.filter((seat) => seat.gameId === table.gameId),
    }));
    const fullest = [...afterKick].sort((a, b) => b.seats.length - a.seats.length)[0];
    const emptiest = [...afterKick].sort((a, b) => a.seats.length - b.seats.length)[0];
    if (!fullest || !emptiest || fullest.table.gameId === emptiest.table.gameId ||
        emptiest.seats.length >= emptiest.table.capacity || fullest.seats.length <= 2) {
      throw new Error("Synthetic fixture did not retain source/target space for a waiting-room transfer");
    }
    const movingSeat = fullest.seats[fullest.seats.length - 1];
    await this.request("waiting-transfer", `games/${fullest.table.gameId}/waiting/transfer`, {
      method: "POST",
      body: {
        token: this.hostTokens[fullest.table.gameId],
        userToken: this.userToken,
        playerId: movingSeat.playerId,
        targetGameId: emptiest.table.gameId,
      },
      phase: "burst",
    });
    movingSeat.gameId = emptiest.table.gameId;
    movingSeat.tableNumber = emptiest.table.tableNumber;

    const feed = this.hostFeed;
    if (!feed) throw new Error("Host SSE must be active before guest restructuring");
    const replacementSequence = feed.lastSequence;
    const replacementStartedAt = performance.now();
    const replacement = await this.request<{
      token: string;
      playerId: string;
      playerName: string;
      gameId: string;
      tableNumber: number;
    }>(
      "join-replacement-after-kick",
      `events/${encodeURIComponent(this.eventCode)}/join`,
      { method: "POST", body: { name: "DEV replacement guest" }, phase: "burst" },
    );
    this.seats.push(replacement.data);
    await observeDashboardChange(
      this,
      feed,
      "replacement-join-after-kick",
      replacementStartedAt,
      replacementSequence,
      (detail) => detail.tables.reduce((sum, table) => sum + table.players.length, 0) === this.expectedGuestSeats,
    );
    if (this.seats.length !== this.expectedGuestSeats) {
      throw new Error(`Fixture must retain all ${this.expectedGuestSeats} guests after replacement join`);
    }
    await settlePoolAfterBurst(this, "kick-transfer-replacement", restructuringSinceMs);
  }

  async readyAndPresenceBurst(): Promise<void> {
    const readySinceMs = Date.now();
    this.poolSampler.setPhase("ready-presence-burst", readySinceMs, "burst");
    const feed = this.hostFeed;
    if (!feed) throw new Error("Host SSE must be active before readiness burst");
    const readySequence = feed.lastSequence;
    const readyStartedAt = performance.now();
    const requests = this.seats.flatMap((seat, index) => [
      () => this.request(`ready-${index + 1}`, `events/${encodeURIComponent(this.eventCode)}/ready`, {
        method: "POST",
        body: { token: seat.token, ready: true },
        phase: "burst",
      }),
      () => this.request(`presence-${index + 1}`, `events/${encodeURIComponent(this.eventCode)}/presence`, {
        method: "POST",
        body: { token: seat.token },
        phase: "burst",
      }),
    ]);
    await this.allSettled("ready + presence burst", requests);
    await observeDashboardChange(
      this,
      feed,
      "ready-burst",
      readyStartedAt,
      readySequence,
      (detail) => detail.tables.length === this.tables.length &&
        detail.tables.every((table) => table.players.length === table.capacity &&
          table.players.every((player) => player.ready && player.connected)),
    );
    await settlePoolAfterBurst(this, "ready-presence-burst", readySinceMs);
  }

  buildReport(scenario: ScenarioName, startedAt: string, status: string): JsonRecord {
    const operations = this.results;
    const latencySummary = (phase: "normal" | "burst", kind: "presence" | "playerActions" | "all") => {
      const values = operations
        .filter((item) => item.phase === phase && item.outcome === "ok")
        .filter((item) => kind === "all" ||
          (kind === "presence"
            ? item.operation.startsWith("presence-")
            : item.operation.startsWith("player-action-")))
        .map((item) => item.durationMs);
      return { count: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) };
    };
    const event = this.manifest.events[0];
    const connectionMetrics = this.dbSamples.length
      ? {
          samples: this.dbSamples.length,
          maxConnections: Math.max(...this.dbSamples.map((sample) => sample.connections)),
          maxActive: Math.max(...this.dbSamples.map((sample) => sample.active)),
          maxLockWaiters: Math.max(...this.dbSamples.map((sample) => sample.lockWaiters)),
          maxIdleInTransaction: Math.max(...this.dbSamples.map((sample) => sample.idleInTransaction)),
          maxLongestActiveSeconds: Math.max(...this.dbSamples.map((sample) => sample.longestActiveSeconds)),
        }
      : null;
    return {
      format: 1,
      mode: process.env.REPLIT_DEPLOYMENT ? "guarded-staging-vm" : "development-only-complete",
      scenario,
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      apiOrigin: this.apiBase.origin,
      fixture: {
        runId: this.manifest.runId,
        facilitatorId: this.manifest.facilitatorId,
        eventId: this.eventId || event.eventId,
        gameIds: this.tables.length ? this.tables.map((table) => table.gameId) : event.gameIds,
        expectedGuestSeats: this.expectedGuestSeats,
        survivingGuestSeats: this.seats.length,
      },
      timings: {
        normal: {
          presence: latencySummary("normal", "presence"),
          playerActions: latencySummary("normal", "playerActions"),
          allRequests: latencySummary("normal", "all"),
        },
        burst: {
          presence: latencySummary("burst", "presence"),
          playerActions: latencySummary("burst", "playerActions"),
          allRequests: latencySummary("burst", "all"),
        },
        allRequests: {
          count: operations.length,
          p95Ms: percentile(operations.filter((item) => item.outcome === "ok").map((item) => item.durationMs), 0.95),
        },
      },
      requestCounts: {
        ok: operations.filter((item) => item.outcome === "ok").length,
        httpErrors: operations.filter((item) => item.outcome === "http_error").length,
        timeouts: operations.filter((item) => item.outcome === "timeout").length,
        otherErrors: operations.filter((item) => item.outcome === "error").length,
      },
      failedOperations: [...new Set(this.failed)],
      failureMessage: this.failureMessage,
      assertions: this.assertions,
      finalScenario: this.finalScenario ?? null,
      dashboardObservations: this.dashboardObservations,
      poolDiagnostics: {
        checkpoints: this.poolCheckpoints,
        samples: this.poolSamples,
        exhaustionIncidents: this.poolExhaustionIncidents,
        samplingErrors: this.poolSamplingErrors,
        trafficWindows: this.finalScenario ? (this.finalScenario as { performance?: { poolDiagnostics?: unknown } }).performance?.poolDiagnostics : null,
      },
      databaseMonitor: connectionMetrics,
      databaseMonitorErrors: {
        count: this.monitorErrors.length,
        types: [...new Set(this.monitorErrors)],
      },
      databaseSamples: this.dbSamples,
      fixtureManifestPath: this.manifestPath,
      cleanup: "After the API is responsive, run --cleanup with the fixture manifest path.",
    };
  }
}

function printUsage(): void {
  console.info(
    "Usage: NODE_ENV=development pnpm --filter @workspace/scripts run event:reliability -- --scenario A|B --confirm-development-database [--deadline-seconds 180] [--request-timeout-ms 12000]\n" +
    "Optional isolated staging VM only: set APP_ENV=staging STAGING_VM_LOADTEST=1 API_BASE_URL=http://localhost:80/api and add --staging-vm (requires REPLIT_DEPLOYMENT)\n" +
    "Cleanup: NODE_ENV=development pnpm --filter @workspace/scripts run event:reliability -- --cleanup scripts/results/<fixture-manifest>.json --confirm-development-database",
  );
}

async function runLoad(options: Map<string, string | boolean>): Promise<void> {
  const scenarioValue = requiredOption(options, "scenario").toUpperCase();
  if (scenarioValue !== "A" && scenarioValue !== "B") throw new Error("--scenario must be A or B");
  const scenario = scenarioValue as ScenarioName;
  const deadlineSeconds = Number(options.get("deadline-seconds") ?? "180");
  const timeoutMs = Number(options.get("request-timeout-ms") ?? "12000");
  if (!Number.isInteger(deadlineSeconds) || deadlineSeconds < 120 || deadlineSeconds > 600) {
    throw new Error("--deadline-seconds must be an integer from 120 to 600 for the real presence-timeout scenario");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new Error("--request-timeout-ms must be an integer from 1000 to 60000");
  }
  const apiBase = apiBaseFromEnvironment(options);
  validateDevelopmentEnvironment(apiBase, options);
  const startedAt = new Date().toISOString();
  const test = new LoadTest(apiBase, scenario, deadlineSeconds, timeoutMs);
  let status = "passed";
  let monitorTask: Promise<void> | undefined;
  const monitorStop = new AbortController();
  try {
    const dbIdentity = await test.monitor.validate();
    await test.poolSampler.start();
    monitorTask = runMonitor(test.monitor, monitorStop.signal, test.dbSamples, test.monitorErrors);
    const health = await test.request<{ status: string }>("api-health", "healthz");
    if (health.data.status !== "ok") throw new Error("Development API health check did not return ok");
    await test.createFacilitator();
    await test.createEvent(scenario);
    await test.reorganizeWaitingGuests();
    await test.readyAndPresenceBurst();
    if (!test.hostFeed) throw new Error("Host SSE feed was not opened before the join burst");
    test.finalScenario = await runCompleteScenario(test, scenario, test.hostFeed);
    const assertions = (test.finalScenario as { assertions?: string[] }).assertions ?? [];
    test.assertions.push(...assertions);
    if (test.poolSamplingErrors.length) {
      test.failed.push(`pool-diagnostics-sampling-errors:${test.poolSamplingErrors.length}`);
    }
    if (test.failed.length) status = "assertion-failed";
    console.info(`Development DB monitor connected (${dbIdentity.database}, PostgreSQL ${dbIdentity.serverVersion}).`);
  } catch (error) {
    status = isTimeout(error) || test.results.some((item) => item.outcome === "timeout")
      ? "stall-or-timeout"
      : test.results.some((item) => item.outcome === "http_error" || item.outcome === "error")
        ? "request-error"
        : "failed";
    test.failureMessage = error instanceof HttpFailure ? error.message : error instanceof Error ? error.message : "unknown error";
    console.error(`Load test stopped: ${test.failureMessage}`);
  } finally {
    await writeFile(test.manifestPath, `${JSON.stringify(test.manifest, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
    if (test.hostFeed?.connectionOpen) await test.hostFeed.close();
    await test.poolSampler.stop();
    if (test.poolSamplingErrors.length && !test.failed.some((item) => item.startsWith("pool-diagnostics-sampling-errors:"))) {
      test.failed.push(`pool-diagnostics-sampling-errors:${test.poolSamplingErrors.length}`);
      if (status === "passed") status = "assertion-failed";
      test.failureMessage ??= "One or more authenticated API-pool diagnostics samples failed";
    }
    if (test.poolExhaustionIncidents.length && status === "passed") {
      status = "assertion-failed";
      test.failureMessage ??= `API-pool exhaustion persisted for at least ${test.poolExhaustionIncidents[0]!.durationMs} ms`;
    }
    monitorStop.abort();
    await monitorTask?.catch(() => undefined);
    await test.monitor.pool.end().catch(() => undefined);
    const report = test.buildReport(scenario, startedAt, status);
    await mkdir(RESULTS_DIR, { recursive: true });
    await writeFile(test.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.info(`Scenario ${scenario}: ${status}`);
    console.info(`Report: ${test.reportPath}`);
    console.info(`Fixture manifest: ${test.manifestPath}`);
    console.info("Credentials and session tokens were not written to the report.");
    if (status !== "passed") process.exitCode = 2;
  }
}

async function cleanupFixtures(options: Map<string, string | boolean>): Promise<void> {
  if (options.get("confirm-development-database") !== true) {
    throw new Error("Refusing cleanup without --confirm-development-database");
  }
  const apiBase = apiBaseFromEnvironment(options);
  validateDevelopmentEnvironment(apiBase, options);
  const manifestPath = await resolveFixtureManifestPath(requiredOption(options, "cleanup"), SCRIPTS_ROOT);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest;
  if (manifest.format !== 1 || !/^[0-9a-f-]{36}$/i.test(manifest.runId) ||
      !manifest.facilitatorId || !/^[0-9a-f-]{36}$/i.test(manifest.facilitatorId) ||
      !Array.isArray(manifest.events) || !manifest.events.length) {
    throw new Error("Fixture manifest is incomplete or has an unsupported format");
  }
  const manifestNames = new Set<string>();
  const manifestEventIds = new Set<string>();
  for (const event of manifest.events) {
    if (event.scenario !== "A" && event.scenario !== "B") {
      throw new Error("Fixture manifest contains an unsupported scenario");
    }
    const expectedName = `${RUN_PREFIX} ${manifest.runId} scenario-${event.scenario}`;
    if (event.name !== expectedName ||
        (event.eventId !== null && (typeof event.eventId !== "string" || !/^[0-9a-f-]{36}$/i.test(event.eventId))) ||
        !Array.isArray(event.gameIds) || event.gameIds.some((gameId) => typeof gameId !== "string" || !gameId)) {
      throw new Error("Fixture manifest contains an invalid or out-of-scope event entry");
    }
    if (manifestNames.has(event.name) || (event.eventId && manifestEventIds.has(event.eventId))) {
      throw new Error("Fixture manifest contains duplicate event ownership entries");
    }
    manifestNames.add(event.name);
    if (event.eventId) manifestEventIds.add(event.eventId);
  }

  const monitor = createMonitor();
  try {
    await monitor.validate();
    const adminPassword = process.env.APP_PASSWORD!;
    const adminRequest = async (path: string, method: string): Promise<number> => {
      const response = await fetch(new URL(path.replace(/^\/+/, ""), `${apiBase.href}/`), {
        method,
        headers: { "x-admin-key": adminPassword },
        signal: AbortSignal.timeout(10000),
      });
      return response.status;
    };
    const expectedEmail = `dev-event-${manifest.runId}@example.test`;
    const expectedUserName = `${RUN_PREFIX} facilitator ${manifest.runId}`;
    const syntheticUser = await monitor.pool.query<{ id: string; email: string; name: string }>(
      `SELECT id,email,name FROM compost_users WHERE id=$1`,
      [manifest.facilitatorId],
    );
    if (syntheticUser.rows.length) {
      const row = syntheticUser.rows[0]!;
      if (row.email !== expectedEmail || row.name !== expectedUserName) {
        throw new Error("Facilitator ID does not match the synthetic identity derived from this manifest");
      }
    }
    const emailOwner = await monitor.pool.query<{ id: string }>(
      `SELECT id FROM compost_users WHERE email=$1`,
      [expectedEmail],
    );
    if (emailOwner.rows.some((row) => row.id !== manifest.facilitatorId)) {
      throw new Error("The synthetic fixture email belongs to an account outside this manifest");
    }

    const eventRows = await monitor.pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM compost_events WHERE facilitator_id = $1 AND name = ANY($2::text[])`,
      [manifest.facilitatorId, manifest.events.map((event) => event.name)],
    );
    const ownedEvents: Array<{ id: string; name: string }> = [];
    const fixtureEventIdByName = new Map<string, string>();
    const expectedOwnerByGameId = new Map<string, string>();
    for (const expectedEvent of manifest.events) {
      const matching = eventRows.rows.filter((row) => row.name === expectedEvent.name);
      if (matching.length > 1) throw new Error("Fixture run marker matched multiple events");
      const discovered = matching[0];
      if (expectedEvent.eventId && discovered && discovered.id !== expectedEvent.eventId) {
        throw new Error("A run marker resolved to an event ID outside the fixture manifest");
      }
      if (expectedEvent.eventId && !discovered) {
        const idOwner = await monitor.pool.query<{ id: string; facilitator_id: string; name: string }>(
          `SELECT id,facilitator_id,name FROM compost_events WHERE id=$1`,
          [expectedEvent.eventId],
        );
        if (idOwner.rows.some((row) =>
          row.facilitator_id !== manifest.facilitatorId || row.name !== expectedEvent.name)) {
          throw new Error("Manifest event ID currently belongs to a different event or facilitator");
        }
      }
      const ownerEventId = discovered?.id ?? expectedEvent.eventId ?? undefined;
      if (discovered) ownedEvents.push(discovered);
      if (ownerEventId) fixtureEventIdByName.set(expectedEvent.name, ownerEventId);
      for (const gameId of expectedEvent.gameIds) {
        const priorOwner = expectedOwnerByGameId.get(gameId);
        if (priorOwner && priorOwner !== ownerEventId) {
          throw new Error("A game ID is attributed to multiple fixture events");
        }
        if (!ownerEventId) throw new Error("Cannot verify a manifest game ID without its owning fixture event ID");
        expectedOwnerByGameId.set(gameId, ownerEventId);
      }
    }

    const eventIds = [...new Set([
      ...fixtureEventIdByName.values(),
      ...manifest.events.map((event) => event.eventId).filter((id): id is string => typeof id === "string"),
    ])];
    const eventTableRows = eventIds.length
      ? await monitor.pool.query<{ event_id: string; game_id: string }>(
          `SELECT event_id,game_id FROM compost_event_tables WHERE event_id = ANY($1::text[])`,
          [eventIds],
        )
      : { rows: [] as Array<{ event_id: string; game_id: string }> };
    const gameIdOwnersFromTables = new Map<string, string>();
    for (const row of eventTableRows.rows) {
      const priorOwner = gameIdOwnersFromTables.get(row.game_id);
      if (priorOwner && priorOwner !== row.event_id) {
        throw new Error("A fixture game ID is linked to multiple Events");
      }
      gameIdOwnersFromTables.set(row.game_id, row.event_id);
      const expectedOwner = expectedOwnerByGameId.get(row.game_id);
      if (expectedOwner && expectedOwner !== row.event_id) {
        throw new Error("Event table ownership does not match the fixture manifest");
      }
      expectedOwnerByGameId.set(row.game_id, row.event_id);
    }
    const seatRows = eventIds.length || expectedOwnerByGameId.size
      ? await monitor.pool.query<{ event_id: string; game_id: string }>(
          `SELECT event_id,game_id FROM compost_event_seats
            WHERE event_id = ANY($1::text[]) OR game_id = ANY($2::text[])`,
          [eventIds, [...expectedOwnerByGameId.keys()]],
        )
      : { rows: [] as Array<{ event_id: string; game_id: string }> };
    for (const seat of seatRows.rows) {
      if (!eventIds.includes(seat.event_id) ||
          expectedOwnerByGameId.get(seat.game_id) !== seat.event_id) {
        throw new Error("An Event seat row does not match verified fixture event/game ownership");
      }
    }
    for (const expectedEvent of manifest.events) {
      const eventId = fixtureEventIdByName.get(expectedEvent.name);
      if (!eventId || !ownedEvents.some((event) => event.id === eventId)) continue;
      const actualGameIds = eventTableRows.rows
        .filter((row) => row.event_id === eventId)
        .map((row) => row.game_id)
        .sort();
      if (expectedEvent.gameIds.length &&
          JSON.stringify([...expectedEvent.gameIds].sort()) !== JSON.stringify(actualGameIds)) {
        throw new Error("The Event's current table IDs do not exactly match the fixture manifest");
      }
    }

    const gameIds = [...expectedOwnerByGameId.keys()];
    const gameRows = gameIds.length
      ? await monitor.pool.query<{ game_id: string; state: unknown }>(
          `SELECT game_id,state FROM compost_games WHERE game_id = ANY($1::text[])`,
          [gameIds],
        )
      : { rows: [] as Array<{ game_id: string; state: unknown }> };
    for (const game of gameRows.rows) {
      const expectedEventId = expectedOwnerByGameId.get(game.game_id);
      const rawState = typeof game.state === "string" ? JSON.parse(game.state) as unknown : game.state;
      if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) {
        throw new Error("A fixture game has no verifiable ownership state");
      }
      const state = rawState as { gameId?: unknown; eventId?: unknown; facilitatorId?: unknown };
      if (!expectedEventId || state.gameId !== game.game_id ||
          state.eventId !== expectedEventId || state.facilitatorId !== manifest.facilitatorId) {
        throw new Error("A game row does not match the fixture event/facilitator ownership");
      }
    }
    const analyticsRows = await monitor.pool.query<{ user_id: string | null; game_id: string | null }>(
      `SELECT user_id,game_id FROM compost_analytics_events
        WHERE user_id=$1 OR game_id = ANY($2::text[])`,
      [manifest.facilitatorId, gameIds],
    );
    for (const row of analyticsRows.rows) {
      if (row.user_id === manifest.facilitatorId && row.game_id !== null &&
          !expectedOwnerByGameId.has(row.game_id)) {
        throw new Error("Synthetic facilitator analytics reference an unverified game ID");
      }
    }

    for (const gameId of gameIds) {
      const status = await adminRequest(`admin/games/${encodeURIComponent(gameId)}`, "DELETE");
      if (status !== 200 && status !== 404) throw new Error(`Admin game cleanup returned HTTP ${status}`);
    }
    await monitor.pool.query(
      `DELETE FROM compost_event_seats
        WHERE event_id = ANY($1::text[]) OR game_id = ANY($2::text[])`,
      [eventIds, gameIds],
    );
    await monitor.pool.query(
      `DELETE FROM compost_event_tables
        WHERE event_id = ANY($1::text[]) OR game_id = ANY($2::text[])`,
      [eventIds, gameIds],
    );
    for (const event of ownedEvents) {
      await monitor.pool.query(
        `DELETE FROM compost_events WHERE id=$1 AND facilitator_id=$2 AND name=$3`,
        [event.id, manifest.facilitatorId, event.name],
      );
    }

    await monitor.pool.query(
      `DELETE FROM compost_analytics_events
        WHERE user_id=$1 OR game_id = ANY($2::text[])`,
      [manifest.facilitatorId, gameIds],
    );
    const userStatus = await adminRequest(`admin/users/${encodeURIComponent(manifest.facilitatorId)}`, "DELETE");
    if (userStatus !== 204 && userStatus !== 404) throw new Error(`Admin facilitator cleanup returned HTTP ${userStatus}`);

    const expectedNames = manifest.events.map((event) => event.name);
    const noLeftovers: Array<{ label: string; count: number }> = [];
    const checkZero = async (label: string, sql: string, values: unknown[]): Promise<void> => {
      const result = await monitor.pool.query<{ count: number | string }>(sql, values);
      const count = Number(result.rows[0]?.count ?? 0);
      if (count !== 0) noLeftovers.push({ label, count });
    };
    await checkZero("events", `
      SELECT COUNT(*)::int AS count FROM compost_events
       WHERE id = ANY($1::text[]) OR (facilitator_id=$2 AND name = ANY($3::text[]))
    `, [eventIds, manifest.facilitatorId, expectedNames]);
    await checkZero("event tables", `
      SELECT COUNT(*)::int AS count FROM compost_event_tables
       WHERE event_id = ANY($1::text[]) OR game_id = ANY($2::text[])
    `, [eventIds, gameIds]);
    await checkZero("event seats", `
      SELECT COUNT(*)::int AS count FROM compost_event_seats
       WHERE event_id = ANY($1::text[]) OR game_id = ANY($2::text[])
    `, [eventIds, gameIds]);
    await checkZero("game tokens", `
      SELECT COUNT(*)::int AS count FROM compost_game_tokens WHERE game_id = ANY($1::text[])
    `, [gameIds]);
    await checkZero("games", `
      SELECT COUNT(*)::int AS count FROM compost_games WHERE game_id = ANY($1::text[])
    `, [gameIds]);
    await checkZero("analytics", `
      SELECT COUNT(*)::int AS count FROM compost_analytics_events
       WHERE user_id=$1 OR game_id = ANY($2::text[])
    `, [manifest.facilitatorId, gameIds]);
    await checkZero("facilitator account", `
      SELECT COUNT(*)::int AS count FROM compost_users WHERE id=$1 OR email=$2
    `, [manifest.facilitatorId, expectedEmail]);
    await checkZero("facilitator sessions", `
      SELECT COUNT(*)::int AS count FROM compost_user_sessions WHERE user_id=$1
    `, [manifest.facilitatorId]);
    if (noLeftovers.length) {
      throw new Error(`Cleanup left fixture metadata behind: ${noLeftovers.map((item) => `${item.label}=${item.count}`).join(", ")}`);
    }
    console.info(`Cleaned only synthetic fixtures for run ${manifest.runId}.`);
    console.info(`Fixture manifest: ${manifestPath}`);
  } finally {
    await monitor.pool.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.has("help")) {
    printUsage();
    return;
  }
  if (options.has("cleanup")) {
    await cleanupFixtures(options);
    return;
  }
  await runLoad(options);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Event reliability harness failed");
  printUsage();
  process.exitCode = 1;
});