import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { pool } from "@workspace/db";
import eventsRouter from "../routes/events.js";
import gameRouter, { serializeState } from "../routes/game.js";
import { createGameState, type GameState } from "../lib/gameEngine.js";
import {
  getCachedGameState, getPlayerIndexForToken, invalidateGameCaches,
  reloadGameState, broadcastToGame,
} from "../lib/gameStore.js";
import { getEventTriviaEnabled, setEventTriviaEnabled } from "../lib/eventTriviaSettings.js";
import { consumeEventStreamTicket, issueEventStreamTicket } from "../lib/eventStreamTickets.js";
import { databaseSafeguardErrorHandler } from "../lib/databaseSafeguardErrorHandler.js";

type TestRows = {
  events: Map<string, any>;
  tables: Map<string, any>;
  seats: Map<string, any>;
  games: Map<string, any>;
  tokens: Map<string, any>;
  users: Map<string, any>;
  sessions: Map<string, string>;
};

function cloneRows(rows: TestRows): TestRows {
  return {
    events: structuredClone(rows.events),
    tables: structuredClone(rows.tables),
    seats: structuredClone(rows.seats),
    games: structuredClone(rows.games),
    tokens: structuredClone(rows.tokens),
    users: structuredClone(rows.users),
    sessions: structuredClone(rows.sessions),
  };
}

function rowSnapshot(rows: TestRows) {
  return Object.fromEntries(Object.entries(rows).map(([key, value]) =>
    [key, [...(value as Map<string, unknown>).entries()].sort(([a], [b]) => a.localeCompare(b))]));
}

function unrelatedEventRows(rows: TestRows, eventId: string) {
  const gameIds = new Set([...rows.tables.values()]
    .filter((table) => table.event_id === eventId)
    .map((table) => table.game_id));
  return {
    events: [...rows.events.values()].filter((event) => event.id === eventId),
    tables: [...rows.tables.values()].filter((table) => table.event_id === eventId),
    seats: [...rows.seats.values()].filter((seat) => seat.event_id === eventId),
    games: [...rows.games.values()].filter((game) => gameIds.has(game.game_id)),
    tokens: [...rows.tokens.values()].filter((token) => gameIds.has(token.game_id)),
  };
}

class FakeClient {
  transaction: TestRows | null = null;
  releasedWith: Error | boolean | undefined;
  unlockFailed = false;

  constructor(private readonly database: FakeDatabase) {}

  query(sql: string, values: unknown[] = []) {
    return this.database.query(sql, values, this);
  }

  release(error?: Error | boolean) {
    this.releasedWith = error;
  }
}

class FakeDatabase {
  rows!: TestRows;
  failEventDelete = false;
  failUnlock = false;
  detailDelay: Promise<void> | null = null;
  onDelayedDetailStarted: (() => void) | null = null;
  credentialLookupQueries = new Map<string, number>();

  async query(sql: string, values: unknown[] = [], client?: FakeClient): Promise<{ rows: any[]; rowCount?: number }> {
    const statement = sql.replace(/\s+/g, " ").trim().toLowerCase();
    const rows = client?.transaction ?? this.rows;
    const eventId = String(values[0] ?? "");

    if (statement === "begin") {
      assert.ok(client);
      client.transaction = cloneRows(this.rows);
      return { rows: [] };
    }
    if (statement === "commit") {
      assert.ok(client?.transaction);
      this.rows = client.transaction;
      client.transaction = null;
      return { rows: [] };
    }
    if (statement === "rollback") {
      assert.ok(client);
      client.transaction = null;
      return { rows: [] };
    }
    if (statement.startsWith("select pg_advisory_lock")) return { rows: [] };
    if (statement.startsWith("select pg_advisory_unlock")) {
      if (this.failUnlock && !client?.unlockFailed) {
        if (client) client.unlockFailed = true;
        throw Object.assign(new Error("simulated advisory unlock failure"), { code: "55P03" });
      }
      return { rows: [{ pg_advisory_unlock: true }] };
    }

    if (statement.includes("from compost_users u") && statement.includes("compost_user_sessions")) {
      const userId = rows.sessions.get(String(values[0]));
      const user = userId ? rows.users.get(userId) : undefined;
      return {
        rows: user ? [{
          id: user.id,
          email: user.email,
          name: user.name,
          organization: user.organization,
          role: user.role === "facilitator" && user.role_approved_at ? "facilitator" : null,
          created_at: user.created_at,
        }] : [],
      };
    }
    if (statement.includes("from compost_events e left join compost_event_tables t")) {
      const event = rows.events.get(eventId);
      if (!event) return { rows: [] };
      const eventTables = [...rows.tables.values()].filter((table) => table.event_id === eventId);
      const resultRows = (eventTables.length ? eventTables : [null]).map((table) => ({
        id: event.id,
        code: event.code,
        name: event.name,
        status: event.status,
        assignment_mode: event.assignment_mode,
        idle_seconds: event.idle_seconds,
        trivia_enabled: event.trivia_enabled,
        last_activity: null,
        game_id: table?.game_id ?? null,
        table_number: table?.table_number ?? null,
        capacity: table?.capacity ?? null,
      }));
      if (this.detailDelay) {
        this.onDelayedDetailStarted?.();
        await this.detailDelay;
      }
      return { rows: resultRows };
    }
    if (statement.startsWith("select id, code, facilitator_id") && statement.includes("from compost_events")) {
      const event = rows.events.get(eventId);
      return { rows: event ? [{ ...event, last_activity: null }] : [] };
    }
    if (statement.startsWith("select id from compost_events")) {
      const event = rows.events.get(eventId);
      return { rows: event ? [{ id: event.id }] : [] };
    }
    if (statement.startsWith("select game_id, table_number, capacity from compost_event_tables")) {
      return { rows: [...rows.tables.values()]
        .filter((table) => table.event_id === eventId)
        .sort((a, b) => a.table_number - b.table_number) };
    }
    if (statement.startsWith("select 1 from compost_event_tables where game_id")) {
      return { rows: [...rows.tables.values()].some((table) => table.game_id === eventId) ? [{ "?column?": 1 }] : [] };
    }
    if (statement.startsWith("select game_id, player_id, ready, last_seen_at from compost_event_seats")) {
      return { rows: [...rows.seats.values()].filter((seat) => seat.event_id === eventId) };
    }
    if (statement.startsWith("select state from compost_games")) {
      const game = rows.games.get(eventId);
      return { rows: game ? [{ state: game.state }] : [] };
    }
    if (statement.startsWith("select token,player_index from compost_game_tokens")) {
      return { rows: [...rows.tokens.values()].filter((token) => token.game_id === eventId)
        .map(({ token, player_index }) => ({ token, player_index })) };
    }
    if (statement.startsWith("select player_index from compost_game_tokens")) {
      const lookupKey = `${String(values[0])}|${String(values[1])}`;
      this.credentialLookupQueries.set(lookupKey, (this.credentialLookupQueries.get(lookupKey) ?? 0) + 1);
      const token = rows.tokens.get(String(values[1]));
      return { rows: token?.game_id === eventId ? [{ player_index: token.player_index }] : [] };
    }
    if (statement.startsWith("select game_id, state from compost_games") && statement.includes("any($1::text[])")) {
      const gameIds = new Set(values[0] as string[]);
      return { rows: [...rows.games.values()].filter((game) => gameIds.has(game.game_id)) };
    }
    if (statement.startsWith("select token, player_index from compost_game_tokens") ||
        statement.startsWith("select game_id, token from compost_game_tokens")) {
      const gameIds = new Set(values[0] as string[]);
      return { rows: [...rows.tokens.values()].filter((token) => gameIds.has(token.game_id)) };
    }
    if (statement.startsWith("delete from compost_game_tokens")) {
      const gameIds = new Set(values[0] as string[]);
      for (const [key, token] of rows.tokens) if (gameIds.has(token.game_id)) rows.tokens.delete(key);
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("delete from compost_event_seats")) {
      for (const [key, seat] of rows.seats) if (seat.event_id === eventId) rows.seats.delete(key);
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("delete from compost_event_tables")) {
      for (const [key, table] of rows.tables) if (table.event_id === eventId) rows.tables.delete(key);
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("delete from compost_games")) {
      const gameIds = new Set(values[0] as string[]);
      for (const gameId of gameIds) rows.games.delete(gameId);
      return { rows: [], rowCount: gameIds.size };
    }
    if (statement.startsWith("delete from compost_events")) {
      if (this.failEventDelete) throw new Error("simulated failure after partial transaction deletes");
      const event = rows.events.get(eventId);
      if (event && event.facilitator_id === values[1] && event.status === "completed") {
        rows.events.delete(eventId);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (statement.startsWith("with phases as")) {
      const gameId = String(values[0]);
      return { rows: [...new Set([...rows.tables.values()]
        .filter((table) => table.game_id === gameId).map((table) => table.event_id))]
        .map((id) => ({ event_id: id })) };
    }
    throw new Error(`Unhandled fake SQL in route-event-delete.test.ts: ${statement}`);
  }

  connect = async () => new FakeClient(this);
}

function fixture(targetId: string, otherId: string, facilitatorId: string, sessionToken: string): TestRows {
  const rows: TestRows = {
    events: new Map(),
    tables: new Map(),
    seats: new Map(),
    games: new Map(),
    tokens: new Map(),
    users: new Map(),
    sessions: new Map(),
  };
  const targetGameIds = [`delete-game-a-${targetId}`, `delete-game-b-${targetId}`];
  const otherGameId = `keep-game-${targetId}`;
  rows.users.set(facilitatorId, {
    id: facilitatorId, email: `${facilitatorId}@test.invalid`, name: "Deletion host",
    organization: null, role: "facilitator", role_approved_at: new Date(), created_at: new Date(),
  });
  rows.users.set(`other-user-${targetId}`, {
    id: `other-user-${targetId}`, email: `other-${targetId}@test.invalid`, name: "Other user",
    organization: null, role: "facilitator", role_approved_at: new Date(), created_at: new Date(),
  });
  rows.sessions.set(sessionToken, facilitatorId);
  rows.sessions.set(`other-session-${targetId}`, `other-user-${targetId}`);
  for (const [id, code, owner, name] of [
    [targetId, `TARGET-${targetId}`, facilitatorId, "Completed Event"],
    [otherId, `OTHER-${targetId}`, `other-user-${targetId}`, "Unrelated Completed Event"],
  ]) {
    rows.events.set(id, {
      id, code, facilitator_id: owner, name, status: "completed",
      assignment_mode: "choose", idle_seconds: 120, trivia_enabled: false,
    });
  }
  const allGameIds = [...targetGameIds, otherGameId];
  for (const [index, gameId] of allGameIds.entries()) {
    const ownerEventId = index < targetGameIds.length ? targetId : otherId;
    const state = createGameState(gameId, ["Guest One", "Guest Two"], "facilitated");
    state.phase = "game_over";
    state.eventId = ownerEventId;
    rows.games.set(gameId, { game_id: gameId, state });
    rows.tables.set(`table-${gameId}`, {
      id: `table-${gameId}`, event_id: ownerEventId, game_id: gameId,
      table_number: index < targetGameIds.length ? index + 1 : 1, capacity: 4,
    });
    for (const [seatIndex, playerId] of state.players.entries()) {
      const seatId = `seat-${gameId}-${seatIndex}`;
      rows.seats.set(seatId, {
        id: seatId, event_id: ownerEventId, game_id: gameId, player_id: playerId.id,
        ready: true, last_seen_at: new Date(),
      });
      const token = `seat-token-${gameId}-${seatIndex}`;
      rows.tokens.set(token, { game_id: gameId, token, player_index: seatIndex });
    }
    const hostToken = `host-token-${gameId}`;
    rows.tokens.set(hostToken, { game_id: gameId, token: hostToken, player_index: -1 });
  }
  return rows;
}

class SseReader {
  private readonly decoder = new TextDecoder();
  private buffered = "";
  constructor(readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}
  async frame(): Promise<{ done: boolean; text: string }> {
    while (!this.buffered.includes("\n\n")) {
      const result = await this.reader.read();
      if (result.done) return { done: true, text: this.buffered };
      this.buffered += this.decoder.decode(result.value, { stream: true });
    }
    const split = this.buffered.indexOf("\n\n");
    const text = this.buffered.slice(0, split);
    this.buffered = this.buffered.slice(split + 2);
    return { done: false, text };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const db = new FakeDatabase();
  const actualPool = pool as any;
  const originalQuery = actualPool.query;
  const originalConnect = actualPool.connect;
  actualPool.query = (sql: string, values?: unknown[]) => db.query(sql, values ?? []);
  actualPool.connect = db.connect;

  const app = express();
  app.use(express.json());
  app.use("/api", gameRouter);
  app.use("/api", eventsRouter);
  app.use(databaseSafeguardErrorHandler);
  app.use((error: unknown, _req: unknown, res: any, _next: unknown) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unexpected error" });
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const targetId = `event-${randomUUID()}`;
  const otherId = `other-event-${randomUUID()}`;
  const facilitatorId = `user-${randomUUID()}`;
  const sessionToken = `session-${randomUUID()}`;
  const rows = fixture(targetId, otherId, facilitatorId, sessionToken);
  db.rows = rows;

  const targetGameIds = [...rows.tables.values()]
    .filter((table) => table.event_id === targetId)
    .map((table) => table.game_id)
    .sort();
  for (const gameId of [...rows.games.keys()]) await reloadGameState(gameId, pool, { cacheGlobal: true });
  const unrelatedGameId = [...rows.tables.values()].find((table) => table.event_id === otherId)!.game_id as string;
  const unrelatedCredential = `seat-token-${unrelatedGameId}-0`;
  assert.equal(await getPlayerIndexForToken(unrelatedGameId, unrelatedCredential), 0,
    "the unrelated credential index is warmed from the process cache");
  const unrelatedCredentialLookupKey = `${unrelatedGameId}|${unrelatedCredential}`;
  const unrelatedCredentialQueriesBefore = db.credentialLookupQueries.get(unrelatedCredentialLookupKey) ?? 0;
  const unrelatedGameWarmSnapshot = structuredClone(getCachedGameState(unrelatedGameId));
  assert.ok(unrelatedGameWarmSnapshot, "the unrelated game snapshot is warmed before deletion");
  const openReaders: SseReader[] = [];
  let releaseDelayedDetail: () => void = () => undefined;
  setEventTriviaEnabled(targetId, false);
  setEventTriviaEnabled(otherId, false);

  const issueTicket = () => issueEventStreamTicket(targetId, sessionToken);
  const openEventStream = async () => {
    const response = await fetch(
      `${base}/facilitator/events/${targetId}/stream?ticket=${encodeURIComponent(issueTicket())}`,
    );
    assert.equal(response.status, 200);
    const reader = new SseReader(response.body!.getReader());
    assert.match((await reader.frame()).text, /"eventId"/);
    openReaders.push(reader);
    return reader;
  };
  const openGameStream = async (gameId: string) => {
    const token = `seat-token-${gameId}-0`;
    const response = await fetch(`${base}/games/${gameId}/events?token=${encodeURIComponent(token)}`);
    assert.equal(response.status, 200);
    const reader = new SseReader(response.body!.getReader());
    assert.match((await reader.frame()).text, /"phase":"game_over"/);
    openReaders.push(reader);
    return reader;
  };
  const deleteEvent = async () => fetch(`${base}/facilitator/events/${targetId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${sessionToken}` },
  });

  try {
    // A transaction that mutates several rowsets and then fails must roll back
    // without evicting the committed game/credential cache or terminating streams.
    const rollbackEventReader = await openEventStream();
    const rollbackGameReader = await openGameStream(targetGameIds[0]);
    const rollbackTicket = issueTicket();
    const beforeRollback = rowSnapshot(db.rows);
    db.failEventDelete = true;
    const rollbackResponse = await deleteEvent();
    db.failEventDelete = false;
    assert.equal(rollbackResponse.status, 500);
    assert.deepEqual(rowSnapshot(db.rows), beforeRollback,
      "rollback retains every event/table/seat/game/token and account row");
    assert.equal(getCachedGameState(targetGameIds[0])?.phase, "game_over",
      "rollback leaves the committed game snapshot cached");
    assert.equal(await getPlayerIndexForToken(targetGameIds[0], `seat-token-${targetGameIds[0]}-0`), 0,
      "rollback leaves seat credentials cached");
    assert.equal(getEventTriviaEnabled(targetId), false, "rollback does not forget event trivia settings");
    assert.ok(consumeEventStreamTicket(rollbackTicket, targetId),
      "rollback does not revoke unused stream tickets");
    const stillOpen = await Promise.race([
      rollbackEventReader.frame().then((frame) => ({ frame })),
      sleep(30).then(() => ({ timedOut: true as const })),
    ]);
    assert.ok("timedOut" in stillOpen, "rollback does not send a terminal Event removal frame");
    const gameStillOpen = await Promise.race([
      rollbackGameReader.frame().then((frame) => ({ frame })),
      sleep(30).then(() => ({ timedOut: true as const })),
    ]);
    assert.ok("timedOut" in gameStillOpen, "rollback does not close the table stream");
    await rollbackEventReader.reader.cancel();
    await rollbackGameReader.reader.cancel();

    // Delay a coalesced detail build after it captured the old Event rows. The
    // committed cleanup must run before advisory unlock, even when unlock then
    // fails and the API correctly reports an ambiguous 503.
    const eventReader = await openEventStream();
    const gameReader = await openGameStream(targetGameIds[0]);
    const revokedTicket = issueTicket();
    let releaseDetail!: () => void;
    let signalDetailStarted!: () => void;
    db.detailDelay = new Promise<void>((resolve) => { releaseDetail = resolve; });
    releaseDelayedDetail = releaseDetail;
    const detailStarted = new Promise<void>((resolve) => { signalDetailStarted = resolve; });
    db.onDelayedDetailStarted = signalDetailStarted;
    broadcastToGame(
      targetGameIds[0],
      rows.games.get(targetGameIds[0]).state as GameState,
      serializeState,
    );
    const broadcastFrame = await gameReader.frame();
    assert.match(broadcastFrame.text, /^data: /);
    await Promise.race([
      detailStarted,
      sleep(2_000).then(() => { throw new Error("coalesced Event detail query did not start"); }),
    ]);

    const beforeDelete = cloneRows(db.rows);
    const unrelatedBaseline = unrelatedEventRows(beforeDelete, otherId);
    const untouchedAccountRows = {
      users: structuredClone(db.rows.users),
      sessions: structuredClone(db.rows.sessions),
    };
    db.failUnlock = true;
    const response = await deleteEvent();
    assert.equal(response.status, 503, "the committed delete is reported as ambiguous when advisory unlock fails");
    const afterDelete = db.rows;
    assert.equal(afterDelete.events.has(targetId), false);
    assert.equal([...afterDelete.tables.values()].some((table) => table.event_id === targetId), false,
      "all target Event table links are removed");
    assert.equal([...afterDelete.seats.values()].some((seat) => seat.event_id === targetId), false,
      "all target Event seats are removed");
    assert.equal([...afterDelete.games.keys()].some((gameId) => targetGameIds.includes(gameId)), false,
      "all target games are removed");
    assert.equal([...afterDelete.tokens.values()].some((token) => targetGameIds.includes(token.game_id)), false,
      "all target seat and host tokens are removed");
    assert.equal(afterDelete.events.has(otherId), true);
    assert.deepEqual(unrelatedEventRows(afterDelete, otherId), unrelatedBaseline,
      "the unrelated Event, table links, seats, games, and all seat/host tokens exactly match their baseline");
    assert.deepEqual(afterDelete.users, untouchedAccountRows.users, "facilitator accounts are untouched");
    assert.deepEqual(afterDelete.sessions, untouchedAccountRows.sessions, "account sessions are untouched");
    assert.ok(targetGameIds.every((gameId) => getCachedGameState(gameId) === undefined),
      "committed deletion evicts every game cache before unlock is attempted");
    assert.equal(await getPlayerIndexForToken(targetGameIds[0], `seat-token-${targetGameIds[0]}-0`), null,
      "committed deletion invalidates cached and durable seat-token lookups");
    assert.deepEqual(getCachedGameState(unrelatedGameId), unrelatedGameWarmSnapshot,
      "deleting the target Event leaves the unrelated warm game snapshot unchanged");
    assert.equal(await getPlayerIndexForToken(unrelatedGameId, unrelatedCredential), 0,
      "the unrelated warm credential index still resolves");
    assert.equal(db.credentialLookupQueries.get(unrelatedCredentialLookupKey) ?? 0, unrelatedCredentialQueriesBefore,
      "the unrelated cached credential lookup needs no new database query");
    assert.equal(getEventTriviaEnabled(targetId), true, "committed deletion clears the Event trivia cache");
    assert.equal(getEventTriviaEnabled(otherId), false, "unrelated Event trivia state remains intact");
    assert.equal(consumeEventStreamTicket(revokedTicket, targetId), null,
      "committed deletion revokes unused Event stream tickets");

    const removedEventFrame = await eventReader.frame();
    assert.match(removedEventFrame.text, /event: event-removed/,
      "the Event control stream terminates despite the subsequent unlock failure");
    const removedGameFrame = await gameReader.frame();
    assert.match(removedGameFrame.text, /event: event-removed/,
      "the table stream terminates despite the subsequent unlock failure");
    releaseDetail();
    await sleep(20);
    assert.equal(getEventTriviaEnabled(targetId), true,
      "a delayed pre-delete settings/detail read cannot repopulate the trivia cache");
    assert.equal((await eventReader.frame()).done, true,
      "the delayed stale detail build cannot publish after terminal Event removal");
    assert.notDeepEqual(rowSnapshot(beforeDelete), rowSnapshot(afterDelete));
  } finally {
    releaseDelayedDetail();
    db.detailDelay = null;
    db.onDelayedDetailStarted = null;
    await Promise.all(openReaders.map((reader) => reader.reader.cancel().catch(() => undefined)));
    invalidateGameCaches(targetGameIds[0]);
    invalidateGameCaches(targetGameIds[1]);
    invalidateGameCaches(`keep-game-${targetId}`);
    setEventTriviaEnabled(otherId, true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    actualPool.query = originalQuery;
    actualPool.connect = originalConnect;
  }
}

await main();
console.log("route-event-delete.test.ts: rollback and commit/unlock-failure assertions passed ✔");