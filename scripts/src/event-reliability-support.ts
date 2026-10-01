import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export type TestPhase = "setup" | "normal" | "burst" | "diagnostic";
export type OperationResult = {
  operation: string;
  phase: TestPhase;
  durationMs: number;
  status: number | null;
  outcome: "ok" | "http_error" | "timeout" | "error";
};
export type RequestOptions = {
  method?: string;
  body?: unknown;
  admin?: boolean;
  bearer?: string;
  stream?: boolean;
  phase?: TestPhase;
};

export type SeatRef = { token: string; playerId: string; playerName: string; gameId: string; tableNumber: number };
export type TableRef = { gameId: string; tableNumber: number; capacity: number };
export type DashboardPlayer = {
  playerId: string;
  playerName: string;
  ready: boolean;
  connected: boolean;
  lastSeenAt: number | null;
};
export type DashboardTable = {
  gameId: string;
  tableNumber: number;
  capacity: number;
  phase: string;
  paused: boolean;
  players: DashboardPlayer[];
  attention: string[];
  message: string | null;
  currentTurnPlayerName: string | null;
};
export type DashboardDetail = {
  eventId: string;
  status: string;
  tables: DashboardTable[];
};
export type DashboardObservation = {
  change: string;
  requestToSseMs: number | null;
  targetMs: number;
  passed: boolean;
  detailSequence?: number;
};
type PoolDiagnosticsPayload = {
  status: string;
  pool: {
    total: number;
    idle: number;
    waiting: number;
    acquisitionWait: { count: number; maxMs: number; p95Ms: number };
  };
};
export type PoolDiagnostics = PoolDiagnosticsPayload & { sinceMs: number };
export type PoolCheckpoint = {
  name: string;
  windowStartedAtMs: number;
  sinceMs: number | null;
  sampledAt: string;
  pool: PoolDiagnostics["pool"] | null;
  settleMs: number | null;
  recovered: boolean;
  maxWaitingDuringSettle: number;
  maxSustainedWaitingMs: number;
};
export type PoolTrafficClass = "setup" | "normal" | "burst";
export type PoolSample = {
  phase: string;
  trafficClass: PoolTrafficClass;
  windowStartedAtMs: number;
  sinceMs: number;
  sampledAt: string;
  sampledAtMs: number;
  pool: PoolDiagnostics["pool"];
};
export type PoolExhaustionIncident = {
  phase: string;
  startedAt: string;
  detectedAt: string;
  durationMs: number;
  waiting: number;
  idle: number;
};
export const POOL_EXHAUSTION_THRESHOLD_MS = 2000;
const POOL_EXHAUSTION_MAX_SAMPLE_GAP_MS = 1500;

export async function resolveFixtureManifestPath(
  rawPath: string,
  scriptsRoot: string,
  cwd = process.cwd(),
): Promise<string> {
  const absoluteScriptsRoot = resolve(scriptsRoot);
  const resultsDirectory = resolve(absoluteScriptsRoot, "results");
  const workspaceRoot = resolve(absoluteScriptsRoot, "..");
  const normalized = rawPath.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  let candidate: string;
  if (isAbsolute(rawPath)) {
    candidate = resolve(rawPath);
  } else if (normalized === "scripts/results" || normalized.startsWith("scripts/results/")) {
    candidate = resolve(workspaceRoot, normalized);
  } else if (normalized === "results" || normalized.startsWith("results/")) {
    candidate = resolve(resultsDirectory, normalized.slice("results".length).replace(/^\/+/, ""));
  } else {
    candidate = resolve(cwd, rawPath);
  }

  const invalidPath = () => {
    throw new Error("Cleanup manifest must be a .fixtures.json file directly inside scripts/results");
  };
  if (dirname(candidate) !== resultsDirectory || !basename(candidate).endsWith(".fixtures.json")) {
    invalidPath();
  }

  const [realScriptsRoot, realResultsDirectory, realCandidate] = await Promise.all([
    realpath(absoluteScriptsRoot),
    realpath(resultsDirectory),
    realpath(candidate),
  ]);
  if (dirname(realResultsDirectory) !== realScriptsRoot ||
      dirname(realCandidate) !== realResultsDirectory ||
      !basename(realCandidate).endsWith(".fixtures.json")) {
    invalidPath();
  }
  return realCandidate;
}

export type ReliabilityContext = {
  apiBase: URL;
  deadline: AbortSignal;
  timeoutMs: number;
  adminPassword: string;
  userToken: string;
  eventId: string;
  eventCode: string;
  runId: string;
  expectedGuestSeats: number;
  runStartedAtMs: number;
  hostTokens: Record<string, string>;
  seats: SeatRef[];
  tables: TableRef[];
  results: OperationResult[];
  failed: string[];
  dashboardObservations: DashboardObservation[];
  poolCheckpoints: PoolCheckpoint[];
  poolSamples: PoolSample[];
  poolExhaustionIncidents: PoolExhaustionIncident[];
  poolSamplingErrors: Array<{ phase: string; sampledAt: string; error: string }>;
  poolSampler: PoolDiagnosticsSampler;
  assertions: string[];
  request<T>(
    operation: string,
    path: string,
    options?: RequestOptions,
  ): Promise<{ data: T; status: number; response: Response }>;
};

export type SseDetailEvent = {
  sequence: number;
  receivedAtMs: number;
  payload: DashboardDetail;
};

function apiUrl(apiBase: URL, path: string): URL {
  return new URL(path.replace(/^\/+/, ""), `${apiBase.href}/`);
}

export function percentile(values: number[], rank: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(rank * sorted.length) - 1)];
}

export class HostEventFeed {
  private readonly events: SseDetailEvent[] = [];
  private readonly listeners = new Set<(event: SseDetailEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private sequence = 0;
  private closed = false;
  private readerTask: Promise<void>;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly controller: AbortController,
  ) {
    this.readerTask = this.readLoop();
  }

  get lastSequence(): number {
    return this.sequence;
  }

  get connectionOpen(): boolean {
    return !this.closed;
  }

  async waitFor(
    predicate: (detail: DashboardDetail) => boolean,
    afterSequence: number,
    timeoutMs: number,
  ): Promise<SseDetailEvent> {
    const prior = this.events.find((event) => event.sequence > afterSequence && predicate(event.payload));
    if (prior) return prior;
    if (this.closed) throw new Error("Host SSE connection closed before the requested dashboard update");
    return new Promise<SseDetailEvent>((resolve, reject) => {
      const finish = (error?: Error, event?: SseDetailEvent) => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        this.closeListeners.delete(onClose);
        if (error) reject(error);
        else resolve(event!);
      };
      const onClose = () => finish(new Error("Host SSE connection closed before the requested dashboard update"));
      const listener = (event: SseDetailEvent) => {
        if (event.sequence <= afterSequence) return;
        try {
          if (predicate(event.payload)) finish(undefined, event);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Dashboard predicate failed"));
        }
      };
      const timer = setTimeout(() => {
        finish(new Error(`No matching host dashboard SSE update within ${timeoutMs} ms`));
      }, timeoutMs);
      this.listeners.add(listener);
      this.closeListeners.add(onClose);
      if (this.closed) onClose();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener();
    this.controller.abort();
    await this.reader.cancel().catch(() => undefined);
    await this.readerTask.catch(() => undefined);
  }

  private acceptFrame(frame: string): void {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return;
    let payload: DashboardDetail;
    try {
      payload = JSON.parse(data) as DashboardDetail;
    } catch {
      return;
    }
    if (!payload || payload.eventId === undefined || !Array.isArray(payload.tables)) return;
    const event = { sequence: ++this.sequence, receivedAtMs: performance.now(), payload };
    this.events.push(event);
    if (this.events.length > 500) this.events.shift();
    for (const listener of [...this.listeners]) listener(event);
  }

  private consumeChunk(text: string): void {
    this.buffer += text;
    let boundary = this.buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0) {
      const frame = this.buffer.slice(0, boundary);
      const separator = this.buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
      this.buffer = this.buffer.slice(boundary + separator.length);
      this.acceptFrame(frame);
      boundary = this.buffer.search(/\r?\n\r?\n/);
    }
  }

  private async readLoop(): Promise<void> {
    try {
      while (!this.closed) {
        const next = await this.reader.read();
        if (next.done) break;
        this.consumeChunk(this.decoder.decode(next.value, { stream: true }));
      }
    } catch {
      // A close/reconnect is reported through waitFor and the scenario report.
    } finally {
      this.closed = true;
      for (const listener of [...this.closeListeners]) listener();
    }
  }
}

export async function openHostEventFeed(context: ReliabilityContext, operation: string): Promise<HostEventFeed> {
  const ticket = await context.request<{ ticket: string }>(
    `${operation}-ticket`,
    `facilitator/events/${context.eventId}/stream-ticket`,
    { method: "POST", body: { userToken: context.userToken }, phase: "setup" },
  );
  const controller = new AbortController();
  const establishing = new AbortController();
  const timeout = setTimeout(() => establishing.abort(), context.timeoutMs);
  const started = performance.now();
  let response: Response | undefined;
  let status: number | null = null;
  try {
    response = await fetch(apiUrl(
      context.apiBase,
      `facilitator/events/${context.eventId}/stream?ticket=${encodeURIComponent(ticket.data.ticket)}`,
    ), {
      headers: { accept: "text/event-stream" },
      cache: "no-store",
      signal: AbortSignal.any([context.deadline, controller.signal, establishing.signal]),
    });
    status = response.status;
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`Host SSE connection returned HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Host SSE response has no body");
    const feed = new HostEventFeed(reader, controller);
    try {
      await feed.waitFor((detail) => detail.eventId === context.eventId, 0, context.timeoutMs);
    } catch (error) {
      await feed.close();
      throw error;
    }
    context.results.push({
      operation,
      phase: "setup",
      durationMs: performance.now() - started,
      status,
      outcome: "ok",
    });
    return feed;
  } catch (error) {
    clearTimeout(timeout);
    controller.abort();
    const timeoutFailure = error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    context.results.push({
      operation,
      phase: "setup",
      durationMs: performance.now() - started,
      status,
      outcome: timeoutFailure ? "timeout" : "error",
    });
    context.failed.push(operation);
    throw error;
  }
}

export async function observeDashboardChange(
  context: ReliabilityContext,
  feed: HostEventFeed,
  change: string,
  requestStartedAt: number,
  afterSequence: number,
  predicate: (detail: DashboardDetail) => boolean,
  timeoutMs = 2000,
): Promise<SseDetailEvent> {
  try {
    const event = await feed.waitFor(predicate, afterSequence, timeoutMs);
    const latency = event.receivedAtMs - requestStartedAt;
    const passed = latency <= timeoutMs;
    context.dashboardObservations.push({
      change,
      requestToSseMs: latency,
      targetMs: timeoutMs,
      passed,
      detailSequence: event.sequence,
    });
    if (!passed) throw new Error(`${change} dashboard update exceeded ${timeoutMs} ms`);
    return event;
  } catch (error) {
    context.dashboardObservations.push({
      change,
      requestToSseMs: null,
      targetMs: timeoutMs,
      passed: false,
    });
    throw error;
  }
}

export async function readPoolDiagnostics(
  context: ReliabilityContext,
  operation: string,
  windowStartedAtMs: number,
): Promise<PoolDiagnostics> {
  const sinceMs = Math.max(0, Date.now() - windowStartedAtMs);
  const result = await context.request<PoolDiagnosticsPayload>(
    operation,
    `admin/healthz?sinceMs=${Math.floor(sinceMs)}`,
    { admin: true, phase: "diagnostic" },
  );
  const snapshot = result.data;
  if (!snapshot || snapshot.status !== "ok" || !snapshot.pool) {
    throw new Error(`${operation} did not return a ready pool diagnostics payload`);
  }
  const values = [
    snapshot.pool.total,
    snapshot.pool.idle,
    snapshot.pool.waiting,
    snapshot.pool.acquisitionWait?.count,
    snapshot.pool.acquisitionWait?.maxMs,
    snapshot.pool.acquisitionWait?.p95Ms,
  ];
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new Error(`${operation} returned an invalid pool diagnostics contract`);
  }
  return { ...snapshot, sinceMs };
}

export async function settlePoolAfterBurst(
  context: ReliabilityContext,
  name: string,
  windowStartedAtMs: number,
  timeoutMs = 10000,
): Promise<PoolCheckpoint> {
  const started = performance.now();
  const deadline = started + timeoutMs;
  let maxWaiting = 0;
  let waitingStarted: number | null = null;
  let maxSustainedWaitingMs = 0;
  let finalSnapshot: PoolDiagnostics | undefined;
  while (performance.now() < deadline) {
    finalSnapshot = await readPoolDiagnostics(context, `pool-${name}`, windowStartedAtMs);
    context.poolSampler.recordSnapshot(`pool-${name}`, "burst", windowStartedAtMs, finalSnapshot);
    const now = performance.now();
    maxWaiting = Math.max(maxWaiting, finalSnapshot.pool.waiting);
    if (finalSnapshot.pool.waiting > 0 && finalSnapshot.pool.idle === 0) {
      waitingStarted ??= now;
      maxSustainedWaitingMs = Math.max(maxSustainedWaitingMs, now - waitingStarted);
    } else {
      waitingStarted = null;
    }
    if (finalSnapshot.pool.waiting === 0 && finalSnapshot.pool.idle > 0) {
      const checkpoint: PoolCheckpoint = {
        name,
        windowStartedAtMs,
        sinceMs: finalSnapshot.sinceMs,
        sampledAt: new Date().toISOString(),
        pool: finalSnapshot.pool,
        settleMs: now - started,
        recovered: true,
        maxWaitingDuringSettle: maxWaiting,
        maxSustainedWaitingMs,
      };
      context.poolCheckpoints.push(checkpoint);
      if (maxSustainedWaitingMs >= POOL_EXHAUSTION_THRESHOLD_MS) {
        throw new Error(`${name} left the API pool exhausted for at least ${POOL_EXHAUSTION_THRESHOLD_MS} ms`);
      }
      return checkpoint;
    }
    if (context.deadline.aborted) throw new Error("Overall scenario deadline reached during pool settling");
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  const checkpoint: PoolCheckpoint = {
    name,
    windowStartedAtMs,
    sinceMs: finalSnapshot?.sinceMs ?? null,
    sampledAt: new Date().toISOString(),
    pool: finalSnapshot?.pool ?? null,
    settleMs: null,
    recovered: false,
    maxWaitingDuringSettle: maxWaiting,
    maxSustainedWaitingMs,
  };
  context.poolCheckpoints.push(checkpoint);
  throw new Error(`${name} failed to settle to waiting=0 and idle>0 within ${timeoutMs} ms`);
}

export class PoolDiagnosticsSampler {
  private phase = "setup";
  private trafficClass: PoolTrafficClass = "setup";
  private windowStartedAtMs = Date.now();
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private resolveDelay?: () => void;
  private loopTask?: Promise<void>;
  private inFlight?: Promise<void>;
  private exhaustion?: {
    phase: string;
    trafficClass: PoolTrafficClass;
    startedAt: string;
    startedAtMs: number;
    lastSampleAtMs: number;
    reported: boolean;
  };

  constructor(private readonly context: ReliabilityContext) {}

  setPhase(
    phase: string,
    windowStartedAtMs = Date.now(),
    trafficClass: PoolTrafficClass = "setup",
  ): void {
    if (trafficClass !== this.trafficClass) this.exhaustion = undefined;
    this.phase = phase;
    this.windowStartedAtMs = windowStartedAtMs;
    this.trafficClass = trafficClass;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.sampleNow();
    this.loopTask = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.resolveDelay?.();
    this.resolveDelay = undefined;
    await this.loopTask?.catch(() => undefined);
    await this.inFlight?.catch(() => undefined);
  }

  async sampleNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const phase = this.phase;
    const trafficClass = this.trafficClass;
    const windowStartedAtMs = this.windowStartedAtMs;
    const task = readPoolDiagnostics(this.context, `pool-background-${phase}`, windowStartedAtMs)
      .then((snapshot) => this.recordSnapshot(phase, trafficClass, windowStartedAtMs, snapshot))
      .catch((error: unknown) => {
        this.context.poolSamplingErrors.push({
          phase,
          sampledAt: new Date().toISOString(),
          error: error instanceof Error ? error.name : "Unknown pool diagnostics error",
        });
      });
    this.inFlight = task;
    try {
      await task;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      await new Promise<void>((resolveDelay) => {
        this.resolveDelay = resolveDelay;
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.resolveDelay = undefined;
          resolveDelay();
        }, 1000);
      });
      if (!this.running) break;
      await this.sampleNow();
    }
  }

  recordSnapshot(
    phase: string,
    trafficClass: PoolTrafficClass,
    windowStartedAtMs: number,
    snapshot: PoolDiagnostics,
  ): void {
    const sampledAtMs = performance.now();
    const sampledAt = new Date().toISOString();
    this.context.poolSamples.push({
      phase,
      trafficClass,
      windowStartedAtMs,
      sinceMs: snapshot.sinceMs,
      sampledAt,
      sampledAtMs,
      pool: snapshot.pool,
    });
    this.trackExhaustion(phase, trafficClass, snapshot.pool, sampledAt, sampledAtMs);
  }

  private trackExhaustion(
    phase: string,
    trafficClass: PoolTrafficClass,
    pool: PoolDiagnostics["pool"],
    sampledAt: string,
    sampledAtMs: number,
  ): void {
    if (pool.waiting <= 0 || pool.idle > 0) {
      this.exhaustion = undefined;
      return;
    }

    if (!this.exhaustion || this.exhaustion.trafficClass !== trafficClass ||
        sampledAtMs - this.exhaustion.lastSampleAtMs > POOL_EXHAUSTION_MAX_SAMPLE_GAP_MS) {
      this.exhaustion = {
        phase,
        trafficClass,
        startedAt: sampledAt,
        startedAtMs: sampledAtMs,
        lastSampleAtMs: sampledAtMs,
        reported: false,
      };
      return;
    }

    this.exhaustion.lastSampleAtMs = sampledAtMs;
    const durationMs = sampledAtMs - this.exhaustion.startedAtMs;
    if (durationMs >= POOL_EXHAUSTION_THRESHOLD_MS && !this.exhaustion.reported) {
      this.exhaustion.reported = true;
      this.context.poolExhaustionIncidents.push({
        phase,
        startedAt: this.exhaustion.startedAt,
        detectedAt: sampledAt,
        durationMs,
        waiting: pool.waiting,
        idle: pool.idle,
      });
      this.context.failed.push(`assertion:pool-exhaustion-sustained-${phase}`);
    }
  }
}

export class PresencePump {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly paused = new Set<string>();
  private stopped = false;
  private requestPhase: "normal" | "burst" = "normal";

  constructor(private readonly context: ReliabilityContext) {}

  setRequestPhase(phase: "normal" | "burst"): void {
    this.requestPhase = phase;
  }

  start(): void {
    for (const seat of this.context.seats) this.schedule(seat);
  }

  async pause(playerId: string): Promise<void> {
    this.paused.add(playerId);
    const timer = this.timers.get(playerId);
    if (timer) clearTimeout(timer);
    this.timers.delete(playerId);
    await this.inFlight.get(playerId)?.catch(() => undefined);
  }

  resume(playerId: string): void {
    this.paused.delete(playerId);
    const seat = this.context.seats.find((candidate) => candidate.playerId === playerId);
    if (seat) this.schedule(seat);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.inFlight.values());
  }

  private schedule(seat: SeatRef): void {
    if (this.stopped || this.paused.has(seat.playerId) || this.timers.has(seat.playerId) ||
        this.inFlight.has(seat.playerId)) return;
    const delay = 12_000 + Math.floor(Math.random() * 6_001);
    const seatNumber = this.context.seats.indexOf(seat) + 1;
    const timer = setTimeout(() => {
      this.timers.delete(seat.playerId);
      if (this.stopped || this.paused.has(seat.playerId)) return;
      const request = this.context.request(
        `presence-steady-seat-${seatNumber}`,
        `events/${encodeURIComponent(this.context.eventCode)}/presence`,
        { method: "POST", body: { token: seat.token }, phase: this.requestPhase },
      ).then(() => undefined).catch(() => undefined).finally(() => {
        this.inFlight.delete(seat.playerId);
        this.schedule(seat);
      });
      this.inFlight.set(seat.playerId, request);
    }, delay);
    this.timers.set(seat.playerId, timer);
  }
}