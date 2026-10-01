import {
  HostEventFeed,
  PresencePump,
  observeDashboardChange,
  openHostEventFeed,
  percentile,
  POOL_EXHAUSTION_THRESHOLD_MS,
  readPoolDiagnostics,
  settlePoolAfterBurst,
  type DashboardDetail,
  type DashboardTable,
  type ReliabilityContext,
  type SeatRef,
  type TableRef,
} from "./event-reliability-support.js";

type ScenarioName = "A" | "B";
type GameState = {
  gameId: string;
  phase: string;
  turnNumber: number;
  deckCount: number;
  currentPlayerIndex: number;
  players: Array<{ id: string; name: string }>;
};
type HostEventDetail = {
  status: string;
  tables: Array<{ gameId: string; tableNumber: number; phase: string }>;
};
type NormalPoolWindow = {
  name: string;
  windowStartedAtMs: number;
  windowEndedAtMs: number;
  durationMs: number;
  sinceMs: number;
  samples: number;
  maxAcquisitionWaitMs: number;
  terminalAcquisitionWait: { count: number; maxMs: number; p95Ms: number };
};
type FinalScenarioReport = {
  mode: "complete-development-scenario";
  scenario: ScenarioName;
  expectedGuestSeats: number;
  survivingGuestSeats: number;
  activeSeatCountAtStart: number;
  activeSeatCountAtEnd: number;
  hostSse: { initialConnection: boolean; reconnects: number; activeAtCompletion: boolean };
  disconnect: { detected: boolean; detectionMs: number | null; recovered: boolean };
  actionRounds: Array<{ round: number; playersPerTable: number; uniqueActivePlayers: number }>;
  performance: {
    overall: {
      presence: { count: number; p50Ms: number | null; p95Ms: number | null };
      playerActions: { count: number; p50Ms: number | null; p95Ms: number | null };
    };
    normal: {
      presence: { count: number; p50Ms: number | null; p95Ms: number | null };
      playerActions: { count: number; p50Ms: number | null; p95Ms: number | null };
    };
    burst: {
      presence: { count: number; p50Ms: number | null; p95Ms: number | null };
      playerActions: { count: number; p50Ms: number | null; p95Ms: number | null };
      allRequests: { count: number; p95Ms: number | null };
    };
    dashboardUpdates: { count: number; passed: number; maxRequestToSseMs: number | null };
    limits: {
      overallPresenceP95Ms: 500;
      overallPlayerActionP95Ms: 1000;
      allScenarioPoolMaxAcquisitionWaitMs: 1000;
      normalPresenceP95Ms: 500;
      normalPlayerActionP95Ms: 1000;
      normalPoolMaxAcquisitionWaitMs: 1000;
      dashboardChangeMs: 2000;
    };
    targets: {
      overallPresenceBelow500Ms: boolean;
      overallPlayerActionBelow1000Ms: boolean;
      allScenarioPoolWaitBelow1000Ms: boolean;
      normalPresenceBelow500Ms: boolean;
      normalPlayerActionBelow1000Ms: boolean;
      normalPoolWaitBelow1000Ms: boolean;
      dashboardChangesBelow2000Ms: boolean;
    };
    poolDiagnostics: {
      scenarioWide: {
        windowStartedAtMs: number;
        sinceMs: number;
        status: string;
        pool: {
          total: number;
          idle: number;
          waiting: number;
          acquisitionWait: { count: number; maxMs: number; p95Ms: number };
        };
      };
      normalWindows: NormalPoolWindow[];
      normalMaxAcquisitionWaitMs: number | null;
      burstAndRecoveryMaxAcquisitionWaitMs: number | null;
      allScenarioMaxAcquisitionWaitMs: number | null;
      exhaustionThresholdMs: number;
    };
  };
  assertions: string[];
};

function assertScenario(context: ReliabilityContext, condition: unknown, message: string): asserts condition {
  if (!condition) {
    context.failed.push(`assertion:${message}`);
    throw new Error(message);
  }
}

function tableSnapshot(detail: DashboardDetail, gameId: string): DashboardTable {
  const table = detail.tables.find((candidate) => candidate.gameId === gameId);
  if (!table) throw new Error(`Host dashboard omitted table ${gameId}`);
  return table;
}

function currentSeat(context: ReliabilityContext, seat: SeatRef): SeatRef {
  const found = context.seats.find((candidate) => candidate.playerId === seat.playerId);
  if (!found) throw new Error("Synthetic action seat was not found in the active fixture");
  return found;
}

async function readHostDetail(
  context: ReliabilityContext,
  operation: string,
  phase: "normal" | "burst" = "normal",
): Promise<HostEventDetail> {
  const response = await context.request<HostEventDetail>(
    operation,
    `facilitator/events/${context.eventId}`,
    { bearer: context.userToken, phase },
  );
  return response.data;
}

async function eventControl(
  context: ReliabilityContext,
  action: string,
  operation: string,
  text?: string,
  phase: "normal" | "burst" = "normal",
): Promise<void> {
  const response = await context.request<{ results?: Array<{ success: boolean }> }>(
    operation,
    `facilitator/events/${context.eventId}/control`,
    {
      method: "POST",
      body: {
        userToken: context.userToken,
        action,
        ...(text ? { text } : {}),
      },
      phase,
    },
  );
  if (response.data.results?.some((result) => !result.success)) {
    throw new Error(`${operation} returned an unsuccessful table result`);
  }
}

async function getGameState(
  context: ReliabilityContext,
  table: TableRef,
  observer: SeatRef,
  operation: string,
  phase: "normal" | "burst" = "normal",
): Promise<GameState> {
  const result = await context.request<GameState>(
    operation,
    `games/${table.gameId}?token=${encodeURIComponent(observer.token)}`,
    { phase },
  );
  if (result.data.gameId !== table.gameId) {
    throw new Error(`${operation} returned state belonging to a different table`);
  }
  return result.data;
}

async function takeLegalTurn(
  context: ReliabilityContext,
  feed: HostEventFeed,
  table: TableRef,
  round: number,
  phase: "normal" | "burst",
  visitedPlayers: Set<string>,
  operationSuffix: string,
  jitterMs = 0,
): Promise<{ gameState: GameState; actorId: string; startedAt: number; sequence: number }> {
  if (jitterMs > 0) {
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, Math.floor(Math.random() * jitterMs)));
  }
  const startedAt = performance.now();
  const feedSequence = feed.lastSequence;
  const observers = context.seats.filter((seat) => seat.gameId === table.gameId);
  if (!observers.length) throw new Error(`No synthetic guests remain at table ${table.tableNumber}`);
  const before = await getGameState(
    context,
    table,
    observers[0]!,
    `player-state-${operationSuffix}`,
    phase,
  );
  assertScenario(context, before.phase === "draw", `Table ${table.tableNumber} was not ready for a legal draw`);
  const actor = before.players[before.currentPlayerIndex];
  if (!actor) throw new Error(`Table ${table.tableNumber} returned no current player`);
  const actorCandidate = context.seats.find((seat) => seat.playerId === actor.id);
  if (!actorCandidate) throw new Error(`Table ${table.tableNumber} current player is not a synthetic guest`);
  const actorSeat = currentSeat(context, actorCandidate);
  visitedPlayers.add(actor.id);
  const drawn = await context.request<GameState>(
    `player-action-${operationSuffix}-draw`,
    `games/${table.gameId}/action`,
    {
      method: "POST",
      body: { token: actorSeat.token, playerId: actor.id, type: "draw_card" },
      phase,
    },
  );
  assertScenario(
    context,
    drawn.data.deckCount < before.deckCount,
    `Table ${table.tableNumber} did not consume a card in round ${round}`,
  );
  const ended = await context.request<GameState>(
    `player-action-${operationSuffix}-end-turn`,
    `games/${table.gameId}/action`,
    {
      method: "POST",
      body: { token: actorSeat.token, playerId: actor.id, type: "end_turn" },
      phase,
    },
  );
  assertScenario(
    context,
    ended.data.turnNumber === before.turnNumber + 1 && ended.data.phase === "draw",
    `Table ${table.tableNumber} did not advance exactly one legal turn`,
  );
  return {
    gameState: ended.data,
    actorId: actor.id,
    startedAt,
    sequence: feedSequence,
  };
}

function dashboardReachedTurn(detail: DashboardDetail, table: TableRef, state: GameState): boolean {
  const current = detail.tables.find((candidate) => candidate.gameId === table.gameId);
  const currentPlayer = state.players[state.currentPlayerIndex];
  return Boolean(current && current.phase === "draw" &&
    current.currentTurnPlayerName === currentPlayer?.name);
}

async function runNormalActionRounds(
  context: ReliabilityContext,
  feed: HostEventFeed,
  expectedSeats: number,
): Promise<FinalScenarioReport["actionRounds"]> {
  const tables = context.tables;
  const seatsByTable = new Map(tables.map((table) => [
    table.gameId,
    context.seats.filter((seat) => seat.gameId === table.gameId),
  ]));
  const rosterIds = new Set<string>();
  const tableSnapshots = new Map<string, GameState>();
  const visitedByTable = new Map<string, Set<string>>(tables.map((table) => [table.gameId, new Set()]));
  const initialStates = await Promise.all(tables.map(async (table) => {
    const seatList = seatsByTable.get(table.gameId) ?? [];
    assertScenario(context, seatList.length === table.capacity, `Table ${table.tableNumber} does not retain full seating`);
    const state = await getGameState(context, table, seatList[0]!, `player-state-rounds-${table.tableNumber}`);
    assertScenario(
      context,
      state.players.length === table.capacity,
      `Table ${table.tableNumber} game state does not contain all seats`,
    );
    for (const player of state.players) {
      assertScenario(context, !rosterIds.has(player.id), "Synthetic player state is shared across tables");
      rosterIds.add(player.id);
    }
    tableSnapshots.set(table.gameId, state);
    return state;
  }));
  assertScenario(
    context,
    initialStates.reduce((sum, state) => sum + state.players.length, 0) === expectedSeats,
    "Active game state does not account for every expected guest seat",
  );

  const summaries: FinalScenarioReport["actionRounds"] = [];
  for (let round = 1; round <= 4; round += 1) {
    const turns = await Promise.all(tables.map(async (table) => {
      const visited = visitedByTable.get(table.gameId)!;
      const result = await takeLegalTurn(
        context,
        feed,
        table,
        round,
        "normal",
        visited,
        `normal-r${round}-t${table.tableNumber}`,
        250,
      );
      return { table, result };
    }));
    for (const { table, result } of turns) {
      await observeDashboardChange(
        context,
        feed,
        `action-round-${round}-table-${table.tableNumber}`,
        result.startedAt,
        result.sequence,
        (detail) => dashboardReachedTurn(detail, table, result.gameState),
      );
      tableSnapshots.set(table.gameId, result.gameState);
    }
    summaries.push({
      round,
      playersPerTable: context.tables[0]?.capacity ?? 0,
      uniqueActivePlayers: new Set(turns.map(({ result }) => result.actorId)).size,
    });
  }

  for (const table of tables) {
    const visited = visitedByTable.get(table.gameId)!;
    const original = tableSnapshots.get(table.gameId);
    const seatIds = new Set((seatsByTable.get(table.gameId) ?? []).map((seat) => seat.playerId));
    assertScenario(
      context,
      visited.size === table.capacity && [...visited].every((playerId) => seatIds.has(playerId)),
      `Not every synthetic guest at table ${table.tableNumber} completed a legal turn`,
    );
    const latest = await getGameState(
      context,
      table,
      (seatsByTable.get(table.gameId) ?? [])[0]!,
      `player-state-after-rounds-${table.tableNumber}`,
    );
    const firstRound = initialStates[tables.indexOf(table)];
    assertScenario(
      context,
      original?.gameId === table.gameId &&
        latest.turnNumber === firstRound!.turnNumber + 4 &&
        latest.players.every((player) => seatIds.has(player.id)),
      `Table ${table.tableNumber} state did not advance independently across four rounds`,
    );
  }
  return summaries;
}

async function runBurstActionRound(
  context: ReliabilityContext,
  feed: HostEventFeed,
  pump: PresencePump,
): Promise<void> {
  const sinceMs = Date.now();
  pump.setRequestPhase("burst");
  context.poolSampler.setPhase("parallel-player-action-burst", sinceMs, "burst");
  const round = await Promise.all(context.tables.map((table) =>
    takeLegalTurn(
      context,
      feed,
      table,
      5,
      "burst",
      new Set<string>(),
      `burst-r5-t${table.tableNumber}`,
    ),
  ));
  for (let index = 0; index < context.tables.length; index += 1) {
    const table = context.tables[index]!;
    const result = round[index]!;
    await observeDashboardChange(
      context,
      feed,
      `action-burst-table-${table.tableNumber}`,
      result.startedAt,
      result.sequence,
      (detail) => dashboardReachedTurn(detail, table, result.gameState),
    );
  }
  await settlePoolAfterBurst(context, "parallel-player-action-burst", sinceMs);
}

async function runPauseAndMessages(
  context: ReliabilityContext,
  feed: HostEventFeed,
  pump: PresencePump,
): Promise<void> {
  pump.setRequestPhase("burst");
  let marker = feed.lastSequence;
  let startedAt = performance.now();
  let burstSinceMs = Date.now();
  context.poolSampler.setPhase("pause-all-burst", burstSinceMs, "burst");
  await eventControl(context, "pause_all", "pause-all", undefined, "burst");
  await observeDashboardChange(
    context,
    feed,
    "pause-all",
    startedAt,
    marker,
    (detail) => detail.tables.length === context.tables.length && detail.tables.every((table) => table.paused),
  );
  await settlePoolAfterBurst(context, "pause-all", burstSinceMs);

  marker = feed.lastSequence;
  startedAt = performance.now();
  burstSinceMs = Date.now();
  context.poolSampler.setPhase("resume-all-burst", burstSinceMs, "burst");
  await eventControl(context, "resume_all", "resume-all", undefined, "burst");
  await observeDashboardChange(
    context,
    feed,
    "resume-all",
    startedAt,
    marker,
    (detail) => detail.tables.length === context.tables.length && detail.tables.every((table) => !table.paused),
  );
  await settlePoolAfterBurst(context, "resume-all", burstSinceMs);

  const tableMessages = new Map(context.tables.map((table) => [
    table.gameId,
    `DEV-${context.eventId.slice(0, 8)}-table-${table.tableNumber}`,
  ]));
  marker = feed.lastSequence;
  burstSinceMs = Date.now();
  context.poolSampler.setPhase("table-message-burst", burstSinceMs, "burst");
  const tableStarts = new Map<string, number>();
  const tableRequests = context.tables.map(async (table) => {
    tableStarts.set(table.gameId, performance.now());
    return context.request(
      `table-message-${table.tableNumber}`,
      `facilitator/events/${context.eventId}/tables/${table.gameId}/control`,
      {
        method: "POST",
        body: { userToken: context.userToken, action: "message", text: tableMessages.get(table.gameId) },
        phase: "burst",
      },
    );
  });
  await Promise.all(tableRequests);
  const allMessagesVisible = (detail: DashboardDetail) =>
    context.tables.every((table) =>
      tableSnapshot(detail, table.gameId).message === tableMessages.get(table.gameId)) &&
    context.tables.every((table) =>
      [...tableMessages.entries()].every(([gameId, text]) =>
        gameId === table.gameId || tableSnapshot(detail, table.gameId).message !== text));
  await feed.waitFor(allMessagesVisible, marker, 2000);
  for (const table of context.tables) {
    const event = await feed.waitFor(
      (detail) => tableSnapshot(detail, table.gameId).message === tableMessages.get(table.gameId),
      marker,
      2000,
    );
    const latency = event.receivedAtMs - tableStarts.get(table.gameId)!;
    context.dashboardObservations.push({
      change: `table-message-${table.tableNumber}`,
      requestToSseMs: latency,
      targetMs: 2000,
      passed: latency <= 2000,
      detailSequence: event.sequence,
    });
    assertScenario(context, latency <= 2000, `Table ${table.tableNumber} message was not visible within 2 seconds`);
  }
  await settlePoolAfterBurst(context, "table-messages", burstSinceMs);

  const announcementMarkers = new Map(context.tables.map((table) => [
    table.gameId,
    `DEV-${context.eventId.slice(0, 8)}-announce-${table.tableNumber}`,
  ]));
  marker = feed.lastSequence;
  burstSinceMs = Date.now();
  context.poolSampler.setPhase("host-announcement-burst", burstSinceMs, "burst");
  const announcementStarts = new Map<string, number>();
  await Promise.all(context.tables.map((table) => {
    announcementStarts.set(table.gameId, performance.now());
    return context.request(
      `host-announcement-${table.tableNumber}`,
      `games/${table.gameId}/message`,
      {
        method: "POST",
        body: {
          token: context.hostTokens[table.gameId],
          userToken: context.userToken,
          text: announcementMarkers.get(table.gameId),
        },
        phase: "burst",
      },
    );
  }));
  const announcementsVisible = (detail: DashboardDetail) =>
    context.tables.every((table) =>
      tableSnapshot(detail, table.gameId).message === announcementMarkers.get(table.gameId)) &&
    context.tables.every((table) =>
      [...announcementMarkers.entries()].every(([gameId, text]) =>
        gameId === table.gameId || tableSnapshot(detail, table.gameId).message !== text));
  await feed.waitFor(announcementsVisible, marker, 2000);
  for (const table of context.tables) {
    const event = await feed.waitFor(
      (detail) => tableSnapshot(detail, table.gameId).message === announcementMarkers.get(table.gameId),
      marker,
      2000,
    );
    const latency = event.receivedAtMs - announcementStarts.get(table.gameId)!;
    context.dashboardObservations.push({
      change: `host-announcement-${table.tableNumber}`,
      requestToSseMs: latency,
      targetMs: 2000,
      passed: latency <= 2000,
      detailSequence: event.sequence,
    });
    assertScenario(context, latency <= 2000, `Table ${table.tableNumber} announcement was not visible within 2 seconds`);
  }
  await settlePoolAfterBurst(context, "host-announcements", burstSinceMs);
  pump.setRequestPhase("normal");
}

function operationPercentiles(
  context: ReliabilityContext,
  phase: "normal" | "burst" | "all",
  kind: "presence" | "playerActions" | "all",
): { count: number; p50Ms: number | null; p95Ms: number | null } {
  const values = context.results
    .filter((item) => (phase === "all"
      ? item.phase === "normal" || item.phase === "burst"
      : item.phase === phase) && item.outcome === "ok")
    .filter((item) => {
      if (kind === "all") return true;
      if (kind === "presence") return item.operation.startsWith("presence-");
      return item.operation.startsWith("player-action-");
    })
    .map((item) => item.durationMs);
  return { count: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) };
}

async function finishNormalPoolWindow(
  context: ReliabilityContext,
  name: string,
  windowStartedAtMs: number,
): Promise<NormalPoolWindow> {
  const terminal = await readPoolDiagnostics(context, `pool-normal-window-${name}`, windowStartedAtMs);
  context.poolSampler.recordSnapshot(name, "normal", windowStartedAtMs, terminal);
  const history = context.poolSamples.filter((sample) =>
    sample.trafficClass === "normal" &&
    sample.phase === name &&
    sample.windowStartedAtMs === windowStartedAtMs);
  const sampledMax = Math.max(
    terminal.pool.acquisitionWait.maxMs,
    ...history.map((sample) => sample.pool.acquisitionWait.maxMs),
  );
  return {
    name,
    windowStartedAtMs,
    windowEndedAtMs: Date.now(),
    durationMs: terminal.sinceMs,
    sinceMs: terminal.sinceMs,
    samples: history.length,
    maxAcquisitionWaitMs: sampledMax,
    terminalAcquisitionWait: terminal.pool.acquisitionWait,
  };
}

function maximumOrNull(values: number[]): number | null {
  return values.length ? Math.max(...values) : null;
}

export async function runCompleteScenario(
  context: ReliabilityContext & { runStartedAtMs: number; expectedGuestSeats: number },
  scenario: ScenarioName,
  initialFeed: HostEventFeed,
): Promise<FinalScenarioReport> {
  let feed = initialFeed;
  let feedReconnects = 0;
  let activeAtCompletion = false;
  let pump: PresencePump | undefined;
  let detectedDisconnectMs: number | null = null;
  let disconnectedSeat: SeatRef | undefined;
  const normalPoolWindows: NormalPoolWindow[] = [];
  let assertions = [
    "The host SSE stream was opened before any guest joined.",
    "All requested seats remained active after the kick via a replacement guest.",
  ];
  const expectedSeats = scenario === "A" ? 16 : 32;
  assertScenario(context, context.seats.length === expectedSeats, "Fixture lost a synthetic guest seat before final scenario");

  try {
    const allReadyAndConnected = (detail: DashboardDetail) =>
      detail.tables.length === context.tables.length &&
      detail.tables.every((table) =>
        table.players.length === table.capacity &&
        table.players.every((player) => player.ready && player.connected));
    const readySnapshot = await feed.waitFor(allReadyAndConnected, 0, 2000);
    assertScenario(
      context,
      readySnapshot.payload.tables.reduce((sum, table) => sum + table.players.length, 0) === expectedSeats,
      "The host SSE stream did not show every synthetic seat ready and connected",
    );
    const initialDashboard = await readHostDetail(context, "host-detail-before-start", "burst");
    assertScenario(
      context,
      initialDashboard.tables.every((table) => table.phase === "waiting"),
      "At least one table started before the explicit Start All action",
    );

    const startSinceMs = Date.now();
    context.poolSampler.setPhase("start-and-presence-burst", startSinceMs, "burst");
    const startSequence = feed.lastSequence;
    const startRequestAt = performance.now();
    const startOperations = [
      eventControl(context, "start", "start-all", undefined, "burst"),
      readHostDetail(context, "host-detail-during-start", "burst"),
      ...context.seats.flatMap((seat, index) => [1, 2].map((attempt) =>
        context.request(
          `presence-burst-${index + 1}-${attempt}`,
          `events/${encodeURIComponent(context.eventCode)}/presence`,
          { method: "POST", body: { token: seat.token }, phase: "burst" },
        ),
      )),
    ];
    const startResults = await Promise.allSettled(startOperations);
    assertScenario(
      context,
      startResults.every((result) => result.status === "fulfilled"),
      "Start All, host detail, and reconnect/visibility presence burst had a failed request",
    );
    await observeDashboardChange(
      context,
      feed,
      "start-all",
      startRequestAt,
      startSequence,
      (detail) => detail.status === "active" &&
        detail.tables.length === context.tables.length &&
        detail.tables.every((table) => table.phase !== "waiting"),
    );
    await settlePoolAfterBurst(context, "start-all-presence", startSinceMs);
    assertions.push("Start All and the duplicate reconnect/visibility-unlock presence burst completed.");

    const normalActionsSinceMs = Date.now();
    context.poolSampler.setPhase("normal-action-rounds", normalActionsSinceMs, "normal");
    pump = new PresencePump(context);
    pump.start();

    // Deliberately replace the current one-use ticket/connection, then require an
    // authoritative initial snapshot from the fresh single-use ticket.
    await feed.close();
    feed = await openHostEventFeed(context, "host-sse-reconnect");
    feedReconnects += 1;
    const reconnectedSnapshot = await feed.waitFor(
      (detail) => detail.eventId === context.eventId && detail.tables.length === context.tables.length,
      0,
      context.timeoutMs,
    );
    assertScenario(
      context,
      reconnectedSnapshot.payload.tables.every((table) => table.phase !== "waiting"),
      "Reconnected host SSE did not include the authoritative active-game snapshot",
    );
    assertions.push("Host SSE reconnected with a fresh single-use ticket and authoritative snapshot.");

    const actionRounds = await runNormalActionRounds(context, feed, expectedSeats);
    assertions.push("Every synthetic guest completed one legal draw/end-turn in four rounds.");
    normalPoolWindows.push(await finishNormalPoolWindow(context, "normal-action-rounds", normalActionsSinceMs));
    await runBurstActionRound(context, feed, pump);
    assertions.push("A parallel cross-table player-action burst preserved independent game state.");

    await runPauseAndMessages(context, feed, pump);
    assertions.push("Pause, resume, table messages, and host announcements were visible per table.");

    // Run the actual 45-second liveness timeout and 10-second server sweep. No
    // persisted game or last_seen state is edited by the load harness.
    const disconnectWindowStartedAtMs = Date.now();
    context.poolSampler.setPhase("normal-presence-disconnect", disconnectWindowStartedAtMs, "normal");
    disconnectedSeat = context.seats[0];
    if (!disconnectedSeat) throw new Error("No synthetic seat is available for disconnect simulation");
    const beforeDisconnectState = await getGameState(
      context,
      context.tables.find((table) => table.gameId === disconnectedSeat!.gameId)!,
      disconnectedSeat,
      "disconnect-authoritative-state-before",
    );
    await context.request(
      "presence-before-disconnect",
      `events/${encodeURIComponent(context.eventCode)}/presence`,
      { method: "POST", body: { token: disconnectedSeat.token }, phase: "normal" },
    );
    await pump.pause(disconnectedSeat.playerId);
    const disconnectedAt = performance.now();
    const disconnectSequence = feed.lastSequence;
    const disconnectedEvent = await feed.waitFor(
      (detail) => detail.tables.some((table) =>
        table.players.some((player) => player.playerId === disconnectedSeat!.playerId && !player.connected) &&
        table.attention.includes("disconnected")),
      disconnectSequence,
      60_000,
    );
    detectedDisconnectMs = disconnectedEvent.receivedAtMs - disconnectedAt;
    assertScenario(
      context,
      detectedDisconnectMs <= 60_000,
      "The API did not detect a real presence loss within the 45s timeout plus 10s sweep allowance",
    );
    assertions.push("A deliberately dropped seat was marked disconnected by the real timeout/sweep without DB edits.");

    // Reconnect SSE while the seat remains offline to exercise stale-ticket
    // invalidation and ensure current state is delivered to a new subscriber.
    await feed.close();
    feed = await openHostEventFeed(context, "host-sse-drop-reconnect");
    feedReconnects += 1;
    const authoritativeReconnectSnapshot = await feed.waitFor(
      (detail) => detail.eventId === context.eventId &&
        detail.tables.some((table) =>
          table.players.some((player) => player.playerId === disconnectedSeat!.playerId && !player.connected)),
      0,
      context.timeoutMs,
    );
    assertScenario(
      context,
      authoritativeReconnectSnapshot.payload.eventId === context.eventId,
      "SSE reconnection during a disconnect did not return authoritative Event state",
    );

    const reconnectSequence = feed.lastSequence;
    const reconnectStartedAt = performance.now();
    await context.request(
      "presence-reconnect-disconnected-seat",
      `events/${encodeURIComponent(context.eventCode)}/presence`,
      { method: "POST", body: { token: disconnectedSeat.token }, phase: "normal" },
    );
    await observeDashboardChange(
      context,
      feed,
      "presence-reconnect-dashboard",
      reconnectStartedAt,
      reconnectSequence,
      (detail) => detail.tables.some((table) =>
        table.players.some((player) => player.playerId === disconnectedSeat!.playerId && player.connected) &&
        !table.attention.includes("disconnected")),
    );
    pump.resume(disconnectedSeat.playerId);
    const afterReconnect = await getGameState(
      context,
      context.tables.find((table) => table.gameId === disconnectedSeat!.gameId)!,
      disconnectedSeat,
      "disconnect-authoritative-state-after",
    );
    assertScenario(
      context,
      afterReconnect.gameId === beforeDisconnectState.gameId &&
        afterReconnect.turnNumber === beforeDisconnectState.turnNumber &&
        afterReconnect.deckCount === beforeDisconnectState.deckCount,
      "Reconnected guest did not recover the same authoritative game state",
    );
    assertions.push("Presence reconnection restored the dashboard promptly and preserved authoritative game state.");

    normalPoolWindows.push(await finishNormalPoolWindow(context, "normal-presence-disconnect", disconnectWindowStartedAtMs));
    await runBurstActionRound(context, feed, pump);
    const endBurstSinceMs = Date.now();
    context.poolSampler.setPhase("parallel-game-completion-burst", endBurstSinceMs, "burst");
    const completionSequence = feed.lastSequence;
    const completionStartedAt = performance.now();
    const hostEnds = await Promise.allSettled(context.tables.map((table) =>
      context.request(
        `host-game-end-${table.tableNumber}`,
        `games/${table.gameId}/end`,
        {
          method: "POST",
          body: { token: context.hostTokens[table.gameId], userToken: context.userToken },
          phase: "burst",
        },
      ),
    ));
    assertScenario(
      context,
      hostEnds.every((result) => result.status === "fulfilled"),
      "Parallel host game-end requests had a failure or stall",
    );
    await observeDashboardChange(
      context,
      feed,
      "event-completion",
      completionStartedAt,
      completionSequence,
      (detail) => detail.status === "completed" &&
        detail.tables.length === context.tables.length &&
        detail.tables.every((table) =>
          table.phase === "game_over" &&
          table.players.length === table.capacity &&
          table.players.every((player) => player.connected)),
    );
    const completedDetail = await readHostDetail(context, "host-detail-completed", "burst");
    assertScenario(
      context,
      completedDetail.status === "completed" &&
        completedDetail.tables.every((table) => table.phase === "game_over"),
      "Event did not reach completed after the parallel host game ends",
    );
    await settlePoolAfterBurst(context, "parallel-game-completion", endBurstSinceMs);
    assertions.push("Parallel per-table host ends transitioned every game and the remaining Event to completed.");

    const overallPool = await readPoolDiagnostics(context, "pool-overall-final", context.runStartedAtMs);
    const overallPresence = operationPercentiles(context, "all", "presence");
    const overallActions = operationPercentiles(context, "all", "playerActions");
    const normalPresence = operationPercentiles(context, "normal", "presence");
    const normalActions = operationPercentiles(context, "normal", "playerActions");
    const burstPresence = operationPercentiles(context, "burst", "presence");
    const burstActions = operationPercentiles(context, "burst", "playerActions");
    const burstAll = operationPercentiles(context, "burst", "all");
    const normalPoolMaxWaitMs = maximumOrNull(normalPoolWindows.map((window) => window.maxAcquisitionWaitMs));
    const burstPoolMaxWaitMs = maximumOrNull([
      ...context.poolSamples
        .filter((sample) => sample.trafficClass === "burst")
        .map((sample) => sample.pool.acquisitionWait.maxMs),
      ...context.poolCheckpoints.flatMap((checkpoint) =>
        checkpoint.pool ? [checkpoint.pool.acquisitionWait.maxMs] : []),
    ]);
    const allScenarioPoolMaxWaitMs = maximumOrNull([
      overallPool.pool.acquisitionWait.maxMs,
      ...context.poolSamples
        .filter((sample) => sample.trafficClass === "normal" || sample.trafficClass === "burst")
        .map((sample) => sample.pool.acquisitionWait.maxMs),
      ...context.poolCheckpoints.flatMap((checkpoint) =>
        checkpoint.pool ? [checkpoint.pool.acquisitionWait.maxMs] : []),
    ]);
    const dashboardPassed = context.dashboardObservations.every((observation) => observation.passed);
    const overallPresencePassed = overallPresence.p95Ms !== null && overallPresence.p95Ms < 500;
    const overallActionPassed = overallActions.p95Ms !== null && overallActions.p95Ms < 1000;
    const allScenarioPoolPassed = overallPool.pool.acquisitionWait.count > 0 &&
      allScenarioPoolMaxWaitMs !== null && allScenarioPoolMaxWaitMs <= 1000;
    const normalPresencePassed = normalPresence.p95Ms !== null && normalPresence.p95Ms < 500;
    const normalActionPassed = normalActions.p95Ms !== null && normalActions.p95Ms < 1000;
    const normalPoolPassed = normalPoolWindows.length > 0 &&
      normalPoolWindows.every((window) => window.terminalAcquisitionWait.count > 0) &&
      normalPoolMaxWaitMs !== null && normalPoolMaxWaitMs <= 1000;
    if (overallPresencePassed) assertions.push("Overall successful presence p95 across normal and burst traffic remained below 500ms.");
    else context.failed.push(`assertion:overall presence p95 ${overallPresence.p95Ms ?? "no sample"} ms must be below 500 ms`);
    if (overallActionPassed) assertions.push("Overall successful legal player-action p95 across normal and burst traffic remained below 1s.");
    else context.failed.push(`assertion:overall legal player-action p95 ${overallActions.p95Ms ?? "no sample"} ms must be below 1000 ms`);
    if (allScenarioPoolPassed) assertions.push("Maximum API-pool acquisition wait across the entire scenario remained at or below 1s.");
    else context.failed.push(`assertion:all-scenario API-pool acquisition max ${allScenarioPoolMaxWaitMs ?? "no sample"} ms must be at most 1000 ms`);
    if (normalPresencePassed) assertions.push("Normal presence p95 remained below 500ms.");
    else context.failed.push("assertion:normal presence p95 was not below 500ms");
    if (normalActionPassed) assertions.push("Normal player-action p95 remained below 1s.");
    else context.failed.push("assertion:normal player-action p95 was not below 1s");
    if (normalPoolPassed) assertions.push("Normal-window pool acquisition wait maximum remained at or below 1s.");
    else context.failed.push("assertion:normal-window pool acquisition wait maximum exceeded 1s");
    if (dashboardPassed) assertions.push("All measured dashboard updates arrived within 2s.");
    else context.failed.push("assertion:one or more dashboard updates exceeded 2s");

    await pump.stop();
    activeAtCompletion = feed.connectionOpen;
    assertScenario(context, activeAtCompletion, "Host SSE was not active at scenario completion");
    return {
      mode: "complete-development-scenario",
      scenario,
      expectedGuestSeats: expectedSeats,
      survivingGuestSeats: context.seats.length,
      activeSeatCountAtStart: expectedSeats,
      activeSeatCountAtEnd: context.seats.length,
      hostSse: { initialConnection: true, reconnects: feedReconnects, activeAtCompletion },
      disconnect: {
        detected: detectedDisconnectMs !== null,
        detectionMs: detectedDisconnectMs,
        recovered: disconnectedSeat !== undefined,
      },
      actionRounds,
      performance: {
        overall: { presence: overallPresence, playerActions: overallActions },
        normal: { presence: normalPresence, playerActions: normalActions },
        burst: { presence: burstPresence, playerActions: burstActions, allRequests: { count: burstAll.count, p95Ms: burstAll.p95Ms } },
        dashboardUpdates: {
          count: context.dashboardObservations.length,
          passed: context.dashboardObservations.filter((item) => item.passed).length,
          maxRequestToSseMs: percentile(
            context.dashboardObservations
              .map((item) => item.requestToSseMs)
              .filter((value): value is number => value !== null),
            1,
          ),
        },
        limits: {
          overallPresenceP95Ms: 500,
          overallPlayerActionP95Ms: 1000,
          allScenarioPoolMaxAcquisitionWaitMs: 1000,
          normalPresenceP95Ms: 500,
          normalPlayerActionP95Ms: 1000,
          normalPoolMaxAcquisitionWaitMs: 1000,
          dashboardChangeMs: 2000,
        },
        targets: {
          overallPresenceBelow500Ms: overallPresencePassed,
          overallPlayerActionBelow1000Ms: overallActionPassed,
          allScenarioPoolWaitBelow1000Ms: allScenarioPoolPassed,
          normalPresenceBelow500Ms: normalPresencePassed,
          normalPlayerActionBelow1000Ms: normalActionPassed,
          normalPoolWaitBelow1000Ms: normalPoolPassed,
          dashboardChangesBelow2000Ms: dashboardPassed,
        },
        poolDiagnostics: {
          scenarioWide: {
            windowStartedAtMs: context.runStartedAtMs,
            sinceMs: overallPool.sinceMs,
            status: overallPool.status,
            pool: overallPool.pool,
          },
          normalWindows: normalPoolWindows,
          normalMaxAcquisitionWaitMs: normalPoolMaxWaitMs,
          burstAndRecoveryMaxAcquisitionWaitMs: burstPoolMaxWaitMs,
          allScenarioMaxAcquisitionWaitMs: allScenarioPoolMaxWaitMs,
          exhaustionThresholdMs: POOL_EXHAUSTION_THRESHOLD_MS,
        },
      },
      assertions,
    };
  } finally {
    if (pump) await pump.stop();
    if (feed.connectionOpen) await feed.close();
  }
}