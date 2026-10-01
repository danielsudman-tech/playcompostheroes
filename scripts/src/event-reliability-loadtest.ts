import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";

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
type OperationResult = {
  operation: string;
  durationMs: number;
  status: number | null;
  outcome: "ok" | "http_error" | "timeout" | "error";
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

function apiBaseFromEnvironment(): URL {
  const raw = process.env.API_BASE_URL ?? DEFAULT_API_BASE;
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("API_BASE_URL must not contain credentials, a query string, or a fragment");
  }
  const host = url.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const isReplitDev = host.endsWith(".replit.dev");
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
  if (process.env.REPLIT_DEPLOYMENT) {
    throw new Error("REPLIT_DEPLOYMENT is set; load tests are disabled in deployments");
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

function percentile(values: number[], percentileRank: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentileRank * sorted.length) - 1)];
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
): Promise<void> {
  while (!signal.aborted) {
    try {
      samples.push(await monitor.sample());
    } catch {
      // Monitor errors are represented by the last successful sample count in the report.
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
  readonly failed: string[] = [];
  readonly manifest: FixtureManifest;
  readonly reportPath: string;
  readonly manifestPath: string;
  readonly adminPassword: string;
  readonly monitor: ReturnType<typeof createMonitor>;
  userToken = "";
  eventId = "";
  eventCode = "";
  hostTokens: Record<string, string> = {};
  seats: Seat[] = [];
  tables: Table[] = [];

  constructor(
    apiBase: URL,
    scenario: ScenarioName,
    deadlineSeconds: number,
    timeoutMs: number,
  ) {
    const runId = randomUUID();
    this.apiBase = apiBase;
    this.deadline = makeDeadline(deadlineSeconds);
    this.timeoutMs = timeoutMs;
    this.adminPassword = process.env.APP_PASSWORD!;
    this.monitor = createMonitor();
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
    options: {
      method?: string;
      body?: unknown;
      admin?: boolean;
      bearer?: string;
      stream?: boolean;
    } = {},
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
        this.results.push({ operation, durationMs, status, outcome: "ok" });
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
      this.results.push({ operation, durationMs, status, outcome: "ok" });
      return { data: data as T, status, response };
    } catch (error) {
      const outcome = isTimeout(error) ? "timeout" : error instanceof HttpFailure ? "http_error" : "error";
      this.results.push({ operation, durationMs: performance.now() - startedAt, status, outcome });
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
  }

  async hostEventControl(action: string, operation = `host-${action}`): Promise<void> {
    const result = await this.request(operation, `facilitator/events/${this.eventId}/control`, {
      method: "POST",
      body: {
        userToken: this.userToken,
        action,
        ...(action === "message" ? { text: "Development reliability probe" } : {}),
      },
    });
    const payload = result.data as { results?: Array<{ success: boolean }> };
    if (payload.results?.some((item) => !item.success)) {
      throw new Error(`${operation} returned one or more unsuccessful table results`);
    }
  }

  async reorganizeWaitingGuests(): Promise<void> {
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
    });

    const kickCandidate = fullestBeforeChanges.seats[0];
    if (!kickCandidate) throw new Error("No safe synthetic guest available for the kick fixture");
    await this.request("waiting-kick", `games/${kickCandidate.gameId}/players/${encodeURIComponent(kickCandidate.playerId)}`, {
      method: "DELETE",
      body: {
        token: this.hostTokens[kickCandidate.gameId],
        userToken: this.userToken,
      },
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
    });
    movingSeat.gameId = emptiest.table.gameId;
    movingSeat.tableNumber = emptiest.table.tableNumber;
  }

  async readyAndPresenceBurst(): Promise<void> {
    const requests = this.seats.flatMap((seat, index) => [
      () => this.request(`ready-${index + 1}`, `events/${encodeURIComponent(this.eventCode)}/ready`, {
        method: "POST",
        body: { token: seat.token, ready: true },
      }),
      () => this.request(`presence-${index + 1}`, `events/${encodeURIComponent(this.eventCode)}/presence`, {
        method: "POST",
        body: { token: seat.token },
      }),
    ]);
    await this.allSettled("ready + presence burst", requests);
  }

  async readHostEvent(operation = "host-detail"): Promise<{
    tables: Array<{ gameId: string; tableNumber: number; phase: string }>;
  }> {
    const detail = await this.request<{
      tables: Array<{ gameId: string; tableNumber: number; phase: string }>;
    }>(operation, `facilitator/events/${this.eventId}`, { bearer: this.userToken });
    return detail.data;
  }

  async openHostStream(): Promise<void> {
    const issued = await this.request<{ ticket: string }>(
      "host-stream-ticket",
      `facilitator/events/${this.eventId}/stream-ticket`,
      {
        method: "POST",
        body: { userToken: this.userToken },
      },
    );
    await this.request(
      "host-sse-open",
      `facilitator/events/${this.eventId}/stream?ticket=${encodeURIComponent(issued.data.ticket)}`,
      { stream: true },
    );
  }

  async startBurstAndGameActions(): Promise<void> {
    await this.openHostStream();
    const concurrent = await Promise.allSettled([
      this.hostEventControl("start", "start-all"),
      this.readHostEvent("host-detail-during-start"),
      ...this.seats.flatMap((seat, index) =>
        [1, 2].map((attempt) =>
          this.request(`presence-reconnect-${index + 1}-${attempt}`, `events/${encodeURIComponent(this.eventCode)}/presence`, {
            method: "POST",
            body: { token: seat.token },
          }),
        ),
      ),
    ]);
    if (concurrent.some((item) => item.status === "rejected")) {
      throw new Error("Start-all / host-detail / presence burst had a failure or stall");
    }

    const actionRuns = this.tables.map(async (table, tableIndex) => {
      const observer = this.seats.find((seat) => seat.gameId === table.gameId);
      if (!observer) throw new Error(`No synthetic guest remains at table ${table.tableNumber}`);
      const stateResponse = await this.request<{
        currentPlayerIndex: number;
        players: Array<{ id: string }>;
      }>(`player-action-state-${tableIndex + 1}`, `games/${table.gameId}?token=${encodeURIComponent(observer.token)}`);
      const player = stateResponse.data.players[stateResponse.data.currentPlayerIndex];
      if (!player) throw new Error(`Table ${table.tableNumber} did not return a current player`);
      const actor = this.seats.find((seat) => seat.gameId === table.gameId && seat.playerId === player.id);
      if (!actor) throw new Error(`Table ${table.tableNumber} current player is not a synthetic guest`);
      await this.request(`player-action-draw-${tableIndex + 1}`, `games/${table.gameId}/action`, {
        method: "POST",
        body: { token: actor.token, playerId: actor.playerId, type: "draw_card" },
      });
      await this.request(`player-action-end-turn-${tableIndex + 1}`, `games/${table.gameId}/action`, {
        method: "POST",
        body: { token: actor.token, playerId: actor.playerId, type: "end_turn" },
      });
    });
    const actionResults = await Promise.allSettled(actionRuns);
    if (actionResults.some((item) => item.status === "rejected")) {
      throw new Error("Concurrent player-action burst had a failure or stall");
    }
  }

  async exerciseControlsAndEnd(): Promise<void> {
    await this.hostEventControl("pause_all");
    await this.hostEventControl("resume_all");
    await this.hostEventControl("message");
    await this.readHostEvent("host-detail-after-controls");
    await this.openHostStream();
    await this.hostEventControl("end");
  }

  buildReport(scenario: ScenarioName, startedAt: string, status: string): JsonRecord {
    const operations = this.results;
    const latencySummary = (prefix: string) => {
      const values = operations
        .filter((item) => {
          if (item.outcome !== "ok") return false;
          if (prefix === "playerActions") {
            return item.operation.startsWith("player-action-draw-") ||
              item.operation.startsWith("player-action-end-turn-");
          }
          return item.operation.startsWith(prefix);
        })
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
      mode: "development-only-baseline",
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
        expectedGuestSeats: scenario === "A" ? 16 : 32,
        survivingGuestSeats: this.seats.length,
      },
      timings: {
        presence: latencySummary("presence-"),
        playerActions: latencySummary("playerActions"),
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
      databaseMonitor: connectionMetrics,
      databaseSamples: this.dbSamples,
      fixtureManifestPath: this.manifestPath,
      cleanup: "After the API is responsive, run --cleanup with the fixture manifest path.",
    };
  }
}

function printUsage(): void {
  console.info(
    "Usage: NODE_ENV=development pnpm --filter @workspace/scripts run event:reliability -- --scenario A|B --confirm-development-database [--deadline-seconds 180] [--request-timeout-ms 12000]\n" +
    "Cleanup: NODE_ENV=development pnpm --filter @workspace/scripts run event:reliability -- --cleanup scripts/results/<fixture-manifest>.json --confirm-development-database",
  );
}

async function runLoad(options: Map<string, string | boolean>): Promise<void> {
  const scenarioValue = requiredOption(options, "scenario").toUpperCase();
  if (scenarioValue !== "A" && scenarioValue !== "B") throw new Error("--scenario must be A or B");
  const scenario = scenarioValue as ScenarioName;
  const deadlineSeconds = Number(options.get("deadline-seconds") ?? "180");
  const timeoutMs = Number(options.get("request-timeout-ms") ?? "12000");
  if (!Number.isInteger(deadlineSeconds) || deadlineSeconds < 30 || deadlineSeconds > 600) {
    throw new Error("--deadline-seconds must be an integer from 30 to 600");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new Error("--request-timeout-ms must be an integer from 1000 to 60000");
  }
  const apiBase = apiBaseFromEnvironment();
  validateDevelopmentEnvironment(apiBase, options);
  const startedAt = new Date().toISOString();
  const test = new LoadTest(apiBase, scenario, deadlineSeconds, timeoutMs);
  let status = "passed";
  let monitorTask: Promise<void> | undefined;
  const monitorStop = new AbortController();
  try {
    const dbIdentity = await test.monitor.validate();
    monitorTask = runMonitor(test.monitor, monitorStop.signal, test.dbSamples);
    const health = await test.request<{ status: string }>("api-health", "healthz");
    if (health.data.status !== "ok") throw new Error("Development API health check did not return ok");
    await test.createFacilitator();
    await test.createEvent(scenario);
    await test.reorganizeWaitingGuests();
    await test.readyAndPresenceBurst();
    await test.startBurstAndGameActions();
    await test.exerciseControlsAndEnd();
    console.info(`Development DB monitor connected (${dbIdentity.database}, PostgreSQL ${dbIdentity.serverVersion}).`);
  } catch (error) {
    status = isTimeout(error) || test.results.some((item) => item.outcome === "timeout")
      ? "stall-or-timeout"
      : test.results.some((item) => item.outcome === "http_error" || item.outcome === "error")
        ? "request-error"
        : "failed";
    console.error(`Load test stopped: ${error instanceof HttpFailure ? error.message : error instanceof Error ? error.message : "unknown error"}`);
  } finally {
    await writeFile(test.manifestPath, `${JSON.stringify(test.manifest, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
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

function safeManifestPath(rawPath: string): string {
  const candidate = resolve(rawPath);
  const relative = candidate.slice(RESULTS_DIR.length + 1);
  if (!candidate.startsWith(`${RESULTS_DIR}/`) || !relative || relative.includes("/") || !candidate.endsWith(".fixtures.json")) {
    throw new Error("Cleanup manifest must be a .fixtures.json file directly inside scripts/results");
  }
  return candidate;
}

async function cleanupFixtures(options: Map<string, string | boolean>): Promise<void> {
  if (options.get("confirm-development-database") !== true) {
    throw new Error("Refusing cleanup without --confirm-development-database");
  }
  const apiBase = apiBaseFromEnvironment();
  validateDevelopmentEnvironment(apiBase, options);
  const manifestPath = safeManifestPath(requiredOption(options, "cleanup"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest;
  if (manifest.format !== 1 || !/^[0-9a-f-]{36}$/i.test(manifest.runId) ||
      !manifest.facilitatorId || !Array.isArray(manifest.events) || !manifest.events.length) {
    throw new Error("Fixture manifest is incomplete or has an unsupported format");
  }
  for (const event of manifest.events) {
    const expectedName = `${RUN_PREFIX} ${manifest.runId} scenario-${event.scenario}`;
    if (event.name !== expectedName || (event.eventId !== null && typeof event.eventId !== "string") ||
        !Array.isArray(event.gameIds)) {
      throw new Error("Fixture manifest contains an invalid or out-of-scope event entry");
    }
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
    const eventRows = await monitor.pool.query<{
      id: string;
      name: string;
    }>(
      `SELECT id, name FROM compost_events WHERE facilitator_id = $1 AND name = ANY($2::text[])`,
      [manifest.facilitatorId, manifest.events.map((event) => event.name)],
    );

    for (const expectedEvent of manifest.events) {
      const discovered = eventRows.rows.filter((row) => row.name === expectedEvent.name);
      if (expectedEvent.eventId && !discovered.some((row) => row.id === expectedEvent.eventId)) {
        const recordedExists = await monitor.pool.query<{ id: string }>(
          `SELECT id FROM compost_events WHERE id=$1 AND facilitator_id=$2 AND name=$3`,
          [expectedEvent.eventId, manifest.facilitatorId, expectedEvent.name],
        );
        if (recordedExists.rows.length) throw new Error("Manifest event identity did not match its scoped lookup");
      }
      for (const event of discovered) {
        if (expectedEvent.eventId && event.id !== expectedEvent.eventId) {
          throw new Error("A run marker resolved to an event ID outside the fixture manifest");
        }
        const games = await monitor.pool.query<{ game_id: string }>(
          `SELECT game_id FROM compost_event_tables WHERE event_id=$1`,
          [event.id],
        );
        const gameIds = games.rows.map((row) => row.game_id);
        if (expectedEvent.gameIds.some((gameId) => !gameIds.includes(gameId))) {
          throw new Error("An event table ID did not match the fixture manifest");
        }
        for (const gameId of gameIds) {
          const status = await adminRequest(`admin/games/${encodeURIComponent(gameId)}`, "DELETE");
          if (status !== 200 && status !== 404) throw new Error(`Admin game cleanup returned HTTP ${status}`);
        }
        await monitor.pool.query(
          `DELETE FROM compost_events WHERE id=$1 AND facilitator_id=$2 AND name=$3`,
          [event.id, manifest.facilitatorId, expectedEvent.name],
        );
      }
    }

    const syntheticUser = await monitor.pool.query<{ id: string; email: string; name: string }>(
      `SELECT id,email,name FROM compost_users WHERE id=$1`,
      [manifest.facilitatorId],
    );
    if (syntheticUser.rows.length) {
      const row = syntheticUser.rows[0];
      const expectedEmail = `dev-event-${manifest.runId}@example.test`;
      const expectedName = `${RUN_PREFIX} facilitator ${manifest.runId}`;
      if (row.email !== expectedEmail || row.name !== expectedName) {
        throw new Error("Facilitator ID does not match the synthetic identity derived from this manifest");
      }
    }
    const userStatus = await adminRequest(`admin/users/${encodeURIComponent(manifest.facilitatorId)}`, "DELETE");
    if (userStatus !== 204 && userStatus !== 404) throw new Error(`Admin facilitator cleanup returned HTTP ${userStatus}`);
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