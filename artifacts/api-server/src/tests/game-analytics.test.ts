import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import app from "../app.js";
import { createGameState, drawCardAction, endTurn, type GameState } from "../lib/gameEngine.js";
import { markFirstHumanTurn, readGameEngagement, STORE_GAME_WITH_ANALYTICS_SQL } from "../lib/gameAnalytics.js";
import { invalidateGameCaches, storeGame } from "../lib/gameStore.js";
import { serializeState } from "../routes/game.js";
import { disarmTurnTimer } from "../lib/turnTimerRuntime.js";
import { syncTurnClock, expireTurnClock } from "../lib/turnClock.js";

const suffix = randomUUID();
const ids: string[] = [];
const routeIds: string[] = [];
const mode = `analytics-fixture-${suffix}` as GameState["mode"];
function fixture(waiting = false) {
  const id = `analytics-${randomUUID()}`;
  ids.push(id);
  const state = createGameState(id, ["Human", "Bot"], "standalone", [1]);
  state.mode = mode;
  if (waiting) state.phase = "waiting";
  return state;
}
function copy(state: GameState): GameState { return structuredClone(state); }
function ended(state: GameState, host = false) {
  return { ...copy(state), phase: "game_over" as const, winner: host ? null : state.players[0].id,
    endedByHost: host, endedAt: (state.createdAt ?? Date.now()) + 90_000 };
}

// Genuine human completion, including wins, but not drawing or bot/off-turn progress.
{
  const state = createGameState("human-milestone", ["Human", "Bot"], "standalone", [1]);
  const drawn = drawCardAction(state, state.players[0].id).state;
  markFirstHumanTurn(state, drawn, state.players[0].id, 1234);
  assert.equal(drawn.analyticsFirstTurnCompletedAt, undefined);
  drawn.players[0].hand = drawn.players[0].hand.slice(0, 4);
  const next = endTurn(drawn, drawn.players[0].id).state;
  markFirstHumanTurn(drawn, next, drawn.players[1].id, 1234);
  assert.equal(next.analyticsFirstTurnCompletedAt, undefined, "another seat cannot claim human engagement");
  markFirstHumanTurn(drawn, next, drawn.players[0].id, 1234);
  assert.equal(next.analyticsFirstTurnCompletedAt, 1234);
  markFirstHumanTurn(drawn, next, drawn.players[0].id, 5678);
  assert.equal(next.analyticsFirstTurnCompletedAt, 1234, "first timestamp is immutable");
  for (const index of [-1, 0, 1]) {
    assert.equal("analyticsFirstTurnCompletedAt" in serializeState(next, index), false);
  }
  const botBefore = { ...copy(state), currentPlayerIndex: 1 };
  const botAfter = { ...copy(botBefore), turnNumber: botBefore.turnNumber + 1 };
  markFirstHumanTurn(botBefore, botAfter, botBefore.players[1].id);
  assert.equal(botAfter.analyticsFirstTurnCompletedAt, undefined);
  const won = ended(state);
  markFirstHumanTurn(state, won, state.players[0].id, 2468);
  assert.equal(won.analyticsFirstTurnCompletedAt, 2468, "winning during a turn also engages");
  const hostEnded = ended(state, true);
  markFirstHumanTurn(state, hostEnded, state.players[0].id);
  assert.equal(hostEnded.analyticsFirstTurnCompletedAt, undefined);
}

const client = await pool.connect();
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
async function ledger(gameId: string) {
  return (await client.query("SELECT * FROM compost_game_analytics WHERE game_id=$1", [gameId])).rows[0];
}
async function visible(state: GameState) {
  await storeGame(state, client);
  // Visible only within this uncommitted test transaction, never in user reports.
  await client.query("UPDATE compost_game_analytics SET is_test=false WHERE game_id=$1", [state.gameId]);
}

try {
  const routeState = createGameState(`analytics-route-${suffix}`, ["First", "Second"], "standalone");
  routeIds.push(routeState.gameId);
  routeState.players[0].hand = routeState.players[0].hand.slice(0, 3);
  await storeGame(routeState);
  async function action(type: string) {
    const response = await fetch(`${base}/games/${routeState.gameId}/action`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, playerId: routeState.players[0].id }),
    });
    assert.equal(response.status, 200);
    const json = await response.json() as any;
    assert.equal("analyticsFirstTurnCompletedAt" in json, false);
  }
  await action("draw_card");
  assert.equal((await ledger(routeState.gameId)).first_turn_at, null, "route draw alone does not engage");
  await action("end_turn");
  assert.ok((await ledger(routeState.gameId)).first_turn_at, "route persists human engagement");

  await client.query("BEGIN");
  const state = fixture();
  await visible(state);
  for (let i = 0; i < 3; i++) await storeGame(state, client);
  let row = await ledger(state.gameId);
  assert.equal(row.started, true);
  assert.equal(+row.started_at, state.createdAt);
  assert.deepEqual([row.player_count, row.human_count, row.bot_count], [2, 1, 1]);
  assert.equal(row.first_turn_at, null);
  const engaged = { ...copy(state), turnNumber: state.turnNumber + 1 };
  markFirstHumanTurn(state, engaged, state.players[0].id, state.createdAt! + 10_000);
  engaged.players[0].isBot = true; // Later cover must not rewrite starting seat composition.
  await storeGame(engaged, client);
  await storeGame(ended(engaged), client);
  await storeGame(ended(engaged), client);
  row = await ledger(state.gameId);
  assert.equal(+row.first_turn_at, state.createdAt! + 10_000);
  assert.deepEqual([row.human_count, row.bot_count], [1, 1]);
  assert.equal(row.end_reason, "won");
  assert.equal(+row.ended_at - +row.started_at, 90_000);
  assert.equal((await client.query("SELECT COUNT(*)::int n FROM compost_game_analytics WHERE game_id=$1", [state.gameId])).rows[0].n, 1);

  const waiting = fixture(true);
  await visible(waiting);
  assert.equal((await ledger(waiting.gameId)).started, false);
  assert.equal((await ledger(waiting.gameId)).started_at, null);
  const launched = { ...copy(waiting), phase: "draw" as const };
  await storeGame(launched, client);
  const launchedAt = +(await ledger(waiting.gameId)).started_at;
  await storeGame(launched, client);
  assert.equal(+(await ledger(waiting.gameId)).started_at, launchedAt);

  const host = fixture();
  await visible(host);
  await storeGame(ended(host, true), client);
  assert.equal((await ledger(host.gameId)).end_reason, "host_ended");
  const unlaunched = fixture(true);
  await visible(unlaunched);
  await storeGame(ended(unlaunched, true), client);
  assert.equal((await ledger(unlaunched.gameId)).started, false, "closing an unlaunched room is not a start");

  // The same persistence path captures timer/bot progress without human engagement.
  let timed = fixture();
  timed.mode = "online";
  timed = syncTurnClock({ ...timed, turnTimerSeconds: 30 }, 1000);
  const expired = expireTurnClock(timed, timed.turnDeadlineKey!, timed.turnDeadlineAt!, 31001);
  assert.equal(expired.analyticsFirstTurnCompletedAt, undefined);
  timed.mode = mode;
  expired.mode = mode;
  await visible(timed);
  await storeGame(ended(expired), client);
  assert.equal((await ledger(timed.gameId)).end_reason, "won");
  assert.equal((await ledger(timed.gameId)).first_turn_at, null);

  // Already-active legacy games retain counts without invented timing or seat data.
  const old = fixture();
  await client.query("INSERT INTO compost_games(game_id,state) VALUES($1,$2)", [old.gameId, JSON.stringify(old)]);
  await visible(ended(old));
  const oldRow = await ledger(old.gameId);
  assert.equal(oldRow.legacy, true);
  assert.equal(oldRow.started_at, null);
  assert.equal(oldRow.human_count, null);

  const historical = fixture();
  for (const type of ["game_created", "game_created", "game_completed", "game_completed"]) {
    await client.query(`INSERT INTO compost_analytics_events(event_type,game_id,int_value,metadata)
      VALUES($1,$2,2,$3)`, [type, historical.gameId, JSON.stringify({ mode, bots: 1 })]);
  }
  const testOnly = fixture();
  await storeGame(testOnly, client);
  assert.equal((await ledger(testOnly.gameId)).is_test, true);
  const report = await readGameEngagement(client);
  const metrics = report.byMode.find(r => r.mode === mode)!;
  assert.equal(metrics.createdGames, 7, "duplicates and test games are excluded");
  assert.equal(metrics.startedGames, 6, "unlaunched rooms excluded; historical completions prove a start");
  assert.equal(metrics.completedGames, 4, "historical completion events count once per game");
  assert.equal(metrics.hostEndedGames, 2);
  assert.equal(metrics.timedStarts, 4);
  assert.equal(metrics.firstTurnGames, 1);
  assert.equal(metrics.trackedCompletions, 2);
  assert.equal(metrics.averageDurationSeconds, 90);
  assert.deepEqual([metrics.humanSeats, metrics.botSeats], [5, 5]);
  assert.equal(metrics.legacyGames, 2);

  // A ledger validation failure rolls back the primary state write in the CTE.
  await client.query("SAVEPOINT atomic_failure");
  await assert.rejects(client.query(STORE_GAME_WITH_ANALYTICS_SQL, [
    state.gameId, JSON.stringify({ ...state, mode: undefined, turnNumber: 999 }), true,
  ]));
  await client.query("ROLLBACK TO SAVEPOINT atomic_failure");
  const durable = (await client.query("SELECT state FROM compost_games WHERE game_id=$1", [state.gameId])).rows[0].state;
  assert.notEqual(durable.turnNumber, 999);
  const rollback = fixture();
  await client.query("SAVEPOINT rollback_milestone");
  await storeGame(rollback, client);
  await client.query("ROLLBACK TO SAVEPOINT rollback_milestone");
  assert.equal(await ledger(rollback.gameId), undefined);
  assert.equal((await client.query("SELECT * FROM compost_games WHERE game_id=$1", [rollback.gameId])).rowCount, 0);

  // Validate the real authenticated admin envelope without logging credentials.
  assert.ok(process.env.APP_PASSWORD, "workspace admin auth must be configured");
  const response = await fetch(`${base}/admin/analytics`, {
    headers: { "x-admin-key": process.env.APP_PASSWORD! },
  });
  assert.equal(response.status, 200);
  const json = await response.json() as any;
  assert.equal(json.summary.totalGames, json.gameEngagement.totals.createdGames);
  assert.equal(json.summary.completedGames, json.gameEngagement.totals.completedGames);
  assert.ok(Array.isArray(json.gameEngagement.byMode));
  assert.equal(typeof json.gameEngagement.timingNote, "string");
  console.log("game-analytics.test.ts: milestones, deduplication, waiting rooms, bots/timers, privacy, historical coverage, atomic rollback and admin response passed");
} finally {
  await client.query("ROLLBACK");
  client.release();
  for (const id of ids) { disarmTurnTimer(id); invalidateGameCaches(id); }
  for (const id of routeIds) {
    disarmTurnTimer(id);
    invalidateGameCaches(id);
    await pool.query("DELETE FROM compost_games WHERE game_id=$1", [id]);
    await pool.query("DELETE FROM compost_game_analytics WHERE game_id=$1", [id]);
    await pool.query("DELETE FROM compost_analytics_events WHERE game_id=$1", [id]);
  }
  await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.end();
}
