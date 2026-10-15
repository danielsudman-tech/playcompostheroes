import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import express from "express";
import { pool } from "@workspace/db";
import {
  getPlayerIndexForToken,
  getGame,
  getGameIdForToken,
  invalidateGameCaches,
  reloadGameState,
  readTokenSlotConsistently,
  storeGame,
  updateGameStateCache,
  withClientTransaction,
  type PgClient,
} from "../lib/gameStore.js";
import {
  FINISHED_GAME_CACHE_TTL_MS,
  GAME_CACHE_EVICTION_BATCH_SIZE,
  GameStoreCache,
  IDLE_GAME_CACHE_TTL_MS,
} from "../lib/gameStoreCache.js";
import type { GameState } from "../lib/gameEngine.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve: (value?: T) => resolve(value as T) };
}

function state(
  gameId: string,
  phase: string = "waiting",
  extra: Partial<GameState> = {},
): GameState {
  return {
    gameId,
    mode: "facilitated",
    phase: phase as GameState["phase"],
    players: [{
      id: "player-a",
      name: "Original",
      hand: [],
      compostPile: [],
      skipsNextTurn: false,
      maxHandSize: 7,
      drawsExtraCard: false,
      isBot: false,
    }],
    deck: [],
    discardPile: [],
    activeModifiers: [],
    pendingDecision: null,
    log: [],
    winner: null,
    currentPlayerIndex: 0,
    turnNumber: 0,
    extraTurn: false,
    heroPlayedThisTurn: false,
    actionPlayedThisTurn: false,
    ongoingActionCard: null,
    ongoingBenefitUsedThisTurn: false,
    ...extra,
  } as GameState;
}

// Finished rooms expire in an hour, idle non-event rooms in a day. Event rooms
// are retained regardless of age while waiting or in progress.
{
  const cache = new GameStoreCache<GameState>();
  const now = 10_000;
  cache.setState(state("finished", "game_over", { endedAt: now }), now);
  cache.setTokenIndex("finished", new Map([["finished-token", 0]]), now);
  assert.deepEqual(cache.evict(now + FINISHED_GAME_CACHE_TTL_MS - 1), []);
  assert.deepEqual(cache.evict(now + FINISHED_GAME_CACHE_TTL_MS), ["finished"]);
  assert.equal(cache.getState("finished"), undefined);
  assert.equal(cache.getTokenIndex("finished"), undefined,
    "evicting game state also removes its cached token index");

  cache.setState(state("old-idle", "draw"), now);
  cache.setTokenIndex("old-idle", new Map([["idle-token", 1]]), now);
  assert.deepEqual(cache.evict(now + IDLE_GAME_CACHE_TTL_MS - 1), []);
  assert.deepEqual(cache.evict(now + IDLE_GAME_CACHE_TTL_MS), ["old-idle"]);
  assert.equal(cache.getTokenIndex("old-idle"), undefined);

  cache.setState(state("event-waiting", "waiting", { eventId: "event-a" }), now);
  cache.setTokenIndex("event-waiting", new Map([["waiting-token", 0]]), now);
  cache.setState(state("legacy-event-active", "play"), now);
  cache.markEventMembership("legacy-event-active", true);
  cache.setTokenIndex("legacy-event-active", new Map([["active-token", 0]]), now);
  cache.markEventMembership("event-token-only", true);
  cache.setTokenIndex("event-token-only", new Map([["token-only", 0]]), now);
  assert.deepEqual(cache.evict(now + IDLE_GAME_CACHE_TTL_MS * 2, GAME_CACHE_EVICTION_BATCH_SIZE), []);
  assert.ok(cache.getState("event-waiting"));
  assert.ok(cache.getState("legacy-event-active"),
    "a legacy event relation protects active games without state.eventId");
  assert.ok(cache.getTokenIndex("event-token-only"),
    "token-only cache entries remain protected when their Event membership is known");
  cache.deleteGame("event-waiting");
  assert.equal(cache.getState("event-waiting"), undefined);
  assert.equal(cache.getTokenIndex("event-waiting"), undefined);
  assert.equal(cache.hasEventMembership("event-waiting"), false,
    "explicit deletion invalidation clears the state, token index, and Event membership together");

  const bounded = new GameStoreCache<GameState>();
  for (let index = 0; index < GAME_CACHE_EVICTION_BATCH_SIZE + 5; index++) {
    bounded.setState(state(`batch-${index}`), now);
  }
  assert.equal(bounded.evict(now + IDLE_GAME_CACHE_TTL_MS, GAME_CACHE_EVICTION_BATCH_SIZE * 10).length,
    GAME_CACHE_EVICTION_BATCH_SIZE, "each eviction pass has a hard work limit");
  assert.equal(bounded.evict(now + IDLE_GAME_CACHE_TTL_MS).length, 5,
    "later periodic passes finish the bounded sweep");

  const fair = new GameStoreCache<GameState>();
  for (let index = 0; index < GAME_CACHE_EVICTION_BATCH_SIZE; index++) {
    const id = `protected-${index}`;
    fair.setState(state(id, "waiting", { eventId: "large-event" }), now);
    fair.setTokenIndex(id, new Map(), now);
  }
  fair.setState(state("finished-behind-protected", "game_over", { endedAt: now }), now);
  assert.deepEqual(fair.evict(now + FINISHED_GAME_CACHE_TTL_MS, GAME_CACHE_EVICTION_BATCH_SIZE), []);
  assert.deepEqual(fair.evict(now + FINISHED_GAME_CACHE_TTL_MS, GAME_CACHE_EVICTION_BATCH_SIZE),
    ["finished-behind-protected"],
    "the rotating scan reaches expired finished games beyond a full protected batch");

  const generations = new GameStoreCache<GameState>();
  const preWriteRead = generations.beginRead("delayed-write");
  generations.advanceGeneration("delayed-write");
  generations.setState(state("delayed-write", "play"));
  assert.equal(generations.publishIfCurrent(preWriteRead, () =>
    generations.setState(state("delayed-write", "waiting"))), false,
  "a delayed state read cannot overwrite a later durable write");
  generations.finishRead(preWriteRead);
  assert.equal(generations.getState("delayed-write")?.phase, "play");

  const preDeleteRead = generations.beginRead("delayed-delete");
  generations.deleteGame("delayed-delete");
  assert.equal(generations.publishIfCurrent(preDeleteRead, () =>
    generations.setState(state("delayed-delete"))), false,
  "a delayed read cannot resurrect a deleted game");
  generations.finishRead(preDeleteRead);

  const preInvalidateTokenRead = generations.beginRead("delayed-token");
  generations.setTokenIndex("delayed-token", new Map([["new-token", 1]]));
  generations.deleteGame("delayed-token");
  assert.equal(generations.publishIfCurrent(preInvalidateTokenRead, () =>
    generations.setTokenIndex("delayed-token", new Map([["stale-token", 0]]))), false,
  "a delayed token loader cannot repopulate indexes after invalidation");
  generations.finishRead(preInvalidateTokenRead);
}

const cacheGameId = `cache-copy-${Date.now()}`;
const durableState = state(cacheGameId, "waiting", { eventId: "cache-copy-event" });
updateGameStateCache(durableState);
durableState.players[0].name = "Mutated after cache write";
const returned = (await getGame(cacheGameId))!;
assert.equal(returned.players[0].name, "Original",
  "cache writes own a snapshot rather than the caller's working object");
returned.players[0].name = "Mutated read result";
assert.equal((await getGame(cacheGameId))?.players[0].name, "Original",
  "cache reads return defensive copies");

const failedWriteState = state(cacheGameId, "draw");
await assert.rejects(storeGame(failedWriteState, {
  query: async () => { throw new Error("forced SQL write failure"); },
}), /forced SQL write failure/);
assert.equal((await getGame(cacheGameId))?.phase, "waiting",
  "a failed SQL write leaves the prior durable cache snapshot untouched");

const uncommittedState = state(cacheGameId, "play");
const heldClient = {
  query: async (sql: string) => {
    if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("compost_event_tables")) return { rows: [] };
    return { rows: [{ state: JSON.stringify(uncommittedState) }] };
  },
  release: () => undefined,
} as PgClient;
const reloadedHeldState = (await reloadGameState(cacheGameId, heldClient))!;
assert.equal(reloadedHeldState.phase, "play");
reloadedHeldState.players[0].name = "Mutated reload result";
assert.equal((await getGame(cacheGameId))?.players[0].name, "Original",
  "reloads performed through held clients do not publish transaction snapshots");
await assert.rejects(withClientTransaction(heldClient, async () => {
  const heldSnapshot = (await getGame(cacheGameId, heldClient))!;
  assert.equal(heldSnapshot.phase, "play");
  heldSnapshot.phase = "game_over";
  throw new Error("forced transaction rollback");
}), /forced transaction rollback/);
assert.equal((await getGame(cacheGameId))?.phase, "waiting",
  "held-client reads and rolled-back work cannot poison the global cache");

const nextDurableState = state(cacheGameId, "draw");
const originalPoolQuery = pool.query;
let finishWrite!: () => void;
let signalWriteStarted!: () => void;
const writeStarted = new Promise<void>((resolve) => { signalWriteStarted = resolve; });
try {
  (pool as any).query = async () => {
    assert.equal((await getGame(cacheGameId))?.phase, "waiting",
      "cache remains unchanged until the SQL write succeeds");
    return new Promise((resolve) => {
      finishWrite = () => resolve({ rows: [] });
      signalWriteStarted();
    });
  };
  const write = storeGame(nextDurableState);
  await writeStarted;
  assert.equal((await getGame(cacheGameId))?.phase, "waiting");
  finishWrite();
  await write;
  assert.equal((await getGame(cacheGameId))?.phase, "draw",
    "a successful durable write publishes a cloned snapshot to cache");
} finally {
  (pool as any).query = originalPoolQuery;
}

const deletedGameId = `cache-delete-${Date.now()}`;
updateGameStateCache(state(deletedGameId));
const queryBeforeDeleteCheck = pool.query;
let deletionMissQueriedDatabase = false;
try {
  (pool as any).query = async () => {
    deletionMissQueriedDatabase = true;
    return { rows: [] };
  };
  invalidateGameCaches(deletedGameId);
  assert.equal(await getGame(deletedGameId), undefined);
  assert.equal(deletionMissQueriedDatabase, true,
    "cache invalidation after durable deletion forces a database-backed miss");
} finally {
  (pool as any).query = queryBeforeDeleteCheck;
}

// Exercise the real admin DELETE route: the cache is warm before the request,
// then the next read must rehydrate from the database after successful delete.
const adminGameId = `cache-admin-delete-${Date.now()}`;
updateGameStateCache(state(adminGameId, "waiting", { eventId: "admin-delete-event" }));
assert.ok(await getGame(adminGameId));
const originalAppPassword = process.env.APP_PASSWORD;
const originalAdminQuery = pool.query;
let databaseMissAfterAdminDelete = false;
process.env.APP_PASSWORD = "cache-route-test-key";
try {
  const { default: adminRouter } = await import("../routes/admin.js");
  const app = express();
  app.use("/api", adminRouter);
  (pool as any).query = async (sql: string) => {
    if (sql.startsWith("DELETE FROM compost_game_tokens")) return { rows: [] };
    if (sql.startsWith("DELETE FROM compost_games")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("SELECT state FROM compost_games")) {
      databaseMissAfterAdminDelete = true;
      return { rows: [] };
    }
    throw new Error(`Unexpected query in admin cache test: ${sql}`);
  };
  const server = createServer(app);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        path: `/api/admin/games/${adminGameId}`,
        method: "DELETE",
        headers: { "x-admin-key": "cache-route-test-key" },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, 200);
    assert.equal(await getGame(adminGameId), undefined);
    assert.equal(databaseMissAfterAdminDelete, true,
      "successful admin deletion invalidates the warmed state and token caches");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
} finally {
  (pool as any).query = originalAdminQuery;
  if (originalAppPassword === undefined) delete process.env.APP_PASSWORD;
  else process.env.APP_PASSWORD = originalAppPassword;
}

// Deliberately delay cache-miss reads around writes/deletes to exercise
// per-game generation checks at the gameStore API boundary.
{
  const gameId = `cache-race-write-${Date.now()}`;
  invalidateGameCaches(gameId);
  const staleRows = deferred<{ rows: Array<{ state: string }> }>();
  const readStarted = deferred<void>();
  const originalQuery = pool.query;
  try {
    (pool as any).query = (sql: string) => {
      if (sql.startsWith("SELECT state FROM compost_games")) {
        readStarted.resolve();
        return staleRows.promise;
      }
      if (sql.includes("INSERT INTO compost_games")) return Promise.resolve({ rows: [] });
      throw new Error(`Unexpected write-race query: ${sql}`);
    };
    const delayedRead = getGame(gameId);
    await readStarted.promise;
    await storeGame(state(gameId, "play", { eventId: "write-race-event" }));
    staleRows.resolve({ rows: [{ state: JSON.stringify(state(gameId, "waiting", { eventId: "write-race-event" })) }] });
    assert.equal((await delayedRead)?.phase, "waiting");
    assert.equal((await getGame(gameId))?.phase, "play",
      "a delayed pre-write read cannot overwrite the post-write cache snapshot");
  } finally {
    (pool as any).query = originalQuery;
  }
}

{
  const gameId = `cache-race-delete-${Date.now()}`;
  invalidateGameCaches(gameId);
  const staleRows = deferred<{ rows: Array<{ state: string }> }>();
  const readStarted = deferred<void>();
  const originalQuery = pool.query;
  let selectCount = 0;
  try {
    (pool as any).query = (sql: string) => {
      if (sql.startsWith("SELECT state FROM compost_games")) {
        selectCount++;
        if (selectCount === 1) {
          readStarted.resolve();
          return staleRows.promise;
        }
        return Promise.resolve({ rows: [] });
      }
      throw new Error(`Unexpected delete-race query: ${sql}`);
    };
    const delayedRead = getGame(gameId);
    await readStarted.promise;
    invalidateGameCaches(gameId);
    staleRows.resolve({ rows: [{ state: JSON.stringify(state(gameId, "waiting", { eventId: "delete-race-event" })) }] });
    await delayedRead;
    assert.equal(await getGame(gameId), undefined);
    assert.equal(selectCount, 2,
      "a delayed pre-delete read cannot resurrect the deleted cache entry");
  } finally {
    (pool as any).query = originalQuery;
  }
}

{
  const gameId = `cache-race-token-${Date.now()}`;
  invalidateGameCaches(gameId);
  const tokenRows = deferred<{ rows: Array<{ player_index: number }> }>();
  const eventRows = deferred<{ rows: unknown[] }>();
  const tokenQueryStarted = deferred<void>();
  const eventQueryStarted = deferred<void>();
  const originalQuery = pool.query;
  let tokenQueryCount = 0;
  try {
    (pool as any).query = (sql: string) => {
      if (sql.startsWith("SELECT player_index FROM compost_game_tokens")) {
        tokenQueryCount++;
        if (tokenQueryCount === 1) {
          tokenQueryStarted.resolve();
          return tokenRows.promise;
        }
        return Promise.resolve({ rows: [] });
      }
      if (sql.startsWith("SELECT 1 FROM compost_event_tables")) {
        eventQueryStarted.resolve();
        return eventRows.promise;
      }
      throw new Error(`Unexpected token-race query: ${sql}`);
    };
    const delayedTokenLoad = getPlayerIndexForToken(gameId, "stale-token");
    await tokenQueryStarted.promise;
    tokenRows.resolve({ rows: [{ player_index: 3 }] });
    await eventQueryStarted.promise;
    invalidateGameCaches(gameId);
    eventRows.resolve({ rows: [] });
    assert.equal(await delayedTokenLoad, 3);
    assert.equal(await getPlayerIndexForToken(gameId, "stale-token"), null);
    assert.equal(tokenQueryCount, 2,
      "an invalidated asynchronous token loader cannot repopulate the credential index");
  } finally {
    (pool as any).query = originalQuery;
  }
}

{
  const token = `cache-unknown-game-${Date.now()}`;
  const staleGameId = `cache-token-old-owner-${Date.now()}`;
  const staleRows = deferred<{ rows: Array<{ game_id: string }> }>();
  const queryStarted = deferred<void>();
  const originalQuery = pool.query;
  let queryCount = 0;
  try {
    (pool as any).query = (sql: string) => {
      assert.ok(sql.startsWith("SELECT game_id FROM compost_game_tokens"));
      queryCount++;
      if (queryCount === 1) {
        queryStarted.resolve();
        return staleRows.promise;
      }
      return Promise.resolve({ rows: [] });
    };
    const delayedLookup = getGameIdForToken(token);
    await queryStarted.promise;
    invalidateGameCaches(staleGameId);
    staleRows.resolve({ rows: [{ game_id: staleGameId }] });
    assert.equal(await delayedLookup, null);
    assert.equal(queryCount, 2,
      "unknown-game token lookups capture the global epoch and retry after invalidation");
  } finally {
    (pool as any).query = originalQuery;
  }
}

{
  const gameId = `cache-stale-slot-${Date.now()}`;
  const firstSlot = deferred<{ playerIndex: number }>();
  const firstLoadStarted = deferred<void>();
  let attempts = 0;
  const delayedSlotLookup = readTokenSlotConsistently(async () => {
    attempts++;
    if (attempts === 1) {
      firstLoadStarted.resolve();
      return firstSlot.promise;
    }
    return { playerIndex: 1 };
  });
  await firstLoadStarted.promise;
  invalidateGameCaches(gameId);
  firstSlot.resolve({ playerIndex: 0 });
  assert.deepEqual(await delayedSlotLookup, { playerIndex: 1 });
  assert.equal(attempts, 2,
    "a changed global epoch retries the full token slot lookup instead of returning a stale seat index");
}