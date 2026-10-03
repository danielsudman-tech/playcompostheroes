import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import app from "../app.js";
import { runStartupMigrations } from "../lib/analyticsStore.js";
import { createGameState } from "../lib/gameEngine.js";
import { syncTurnClock } from "../lib/turnClock.js";
import { invalidateGameCaches, withGameMutationLocks, storeGame } from "../lib/gameStore.js";
import { disarmTurnTimer } from "../lib/turnTimerRuntime.js";
import { recordMissedTurn } from "../lib/playerCover.js";

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
const id = `timer-test-${randomUUID()}`, userToken = `${id}-user`;
const games: string[] = [];
let eventId: string | undefined;
async function request(path: string, body?: unknown, method = "POST") {
  const r = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : method,
    headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000) });
  return { status: r.status, data: await r.json() as any };
}
try {
  await runStartupMigrations();
  await pool.query(`INSERT INTO compost_users(id,email,name,role,role_approved_at) VALUES($1,$2,'Sam','facilitator',NOW())`, [id, `${id}@test.invalid`]);
  await pool.query(`INSERT INTO compost_user_sessions(token,user_id) VALUES($1,$2)`, [userToken, id]);
  const created = await request("/games", { mode: "online", hostName: "Sam", userToken, turnTimerSeconds: 30 });
  assert.equal(created.status, 201);
  const gameId = created.data.gameId;
  games.push(gameId);
  const token = created.data.creatorToken;
  assert.equal(created.data.turnDeadlineAt, null);
  assert.equal((await request(`/games/${gameId}/action`, { type: "set_turn_timer", playerId: "player_0", token, data: { turnTimerSeconds: 60 } })).status, 403);
  assert.equal((await request(`/games/${gameId}/action`, { type: "set_turn_timer", playerId: "player_0", token, userToken, data: { turnTimerSeconds: 45 } })).status, 400);
  assert.equal((await request(`/games/${gameId}/action`, { type: "set_turn_timer", playerId: "player_0", token, userToken, data: { turnTimerSeconds: 60 } })).data.turnTimerSeconds, 60);
  const state = syncTurnClock({ ...createGameState(gameId, ["Sam", "Alex"], "online"), facilitatorId: id, turnTimerSeconds: 30 }, Date.now() - 31000);
  await withGameMutationLocks([gameId], client => storeGame(state, client));
  disarmTurnTimer(gameId); // Simulate a process restart: the persisted overdue clock has no timer.
  invalidateGameCaches(gameId);
  const results = await Promise.all([
    request(`/games/${gameId}`),
    request(`/games/${gameId}/action`, { type: "draw_card", token, playerId: "player_0", turnDeadlineKey: state.turnDeadlineKey }),
  ]);
  assert.equal(results[0].status, 200);
  assert.equal(results[1].status, 409, "late action loses to the overdue durable deadline");
  const persisted = (await pool.query(`SELECT state FROM compost_games WHERE game_id=$1`, [gameId])).rows[0].state;
  assert.equal(persisted.turnNumber, 2);
  const reset = await request(`/games/${gameId}/action`, {
    type: "reset_game", token, playerId: "player_0", turnDeadlineKey: persisted.turnDeadlineKey,
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.turnTimerSeconds, 30, "reset retains the host timer setting");
  assert.ok(reset.data.turnDeadlineAt > Date.now());
  assert.notEqual(reset.data.turnDeadlineKey, state.turnDeadlineKey, "old round requests cannot match a reset round");
  assert.equal(persisted.log.filter((l: string) => l.startsWith("Time ran out.")).length, 1);
  assert.ok(persisted.turnDeadlineAt > Date.now());
  let covered = syncTurnClock(recordMissedTurn(recordMissedTurn({
    ...createGameState(gameId, ["Sam", "Alex"], "online"), facilitatorId: id, turnTimerSeconds: 30,
  }, "player_0"), "player_0"));
  await withGameMutationLocks([gameId], client => storeGame(covered, client));
  assert.equal((await request(`/games/${gameId}/action`, { type: "take_back_seat", token, playerId: "player_1" })).status, 403);
  assert.equal((await request(`/games/${gameId}/action`, { type: "draw_card", token, playerId: "player_0", turnDeadlineKey: covered.turnDeadlineKey })).status, 409);
  const returned = await request(`/games/${gameId}/action`, { type: "take_back_seat", token, playerId: "player_0" });
  assert.equal(returned.status, 200);
  assert.equal(returned.data.players[0].isBot, false);
  assert.equal(returned.data.players[0].consecutiveMissedTurns, 0);
  assert.equal(returned.data.currentPlayerIndex, 0);
  assert.equal((await request(`/games/${gameId}/action`, { type: "draw_card", token, playerId: "player_0", turnDeadlineKey: returned.data.turnDeadlineKey })).status, 200);
  const event = await request("/facilitator/events", { userToken, name: "Timer event", tableCount: 2, turnTimerSeconds: 90 });
  assert.equal(event.status, 201);
  eventId = event.data.eventId;
  games.push(...event.data.tables.map((t: any) => t.gameId));
  assert.equal(event.data.turnTimerSeconds, 90);
  const changed = await request(`/facilitator/events/${eventId}`, { userToken, turnTimerSeconds: 120 }, "PATCH");
  assert.equal(changed.status, 200);
  assert.equal(changed.data.turnTimerSeconds, 120);
  for (const table of event.data.tables) {
    const dto = (await request(`/games/${table.gameId}`)).data;
    assert.equal(dto.turnTimerSeconds, 120);
    assert.equal(dto.turnDeadlineAt, null);
  }
  console.log("route-turn-clock.test.ts: host setting, event propagation, lazy restart and expiry/action race passed");
} finally {
  for (const gameId of games) disarmTurnTimer(gameId);
  if (eventId) await pool.query(`DELETE FROM compost_events WHERE id=$1`, [eventId]);
  for (const gameId of games) {
    invalidateGameCaches(gameId);
    await pool.query(`DELETE FROM compost_game_tokens WHERE game_id=$1`, [gameId]);
    await pool.query(`DELETE FROM compost_games WHERE game_id=$1`, [gameId]);
  }
  await pool.query(`DELETE FROM compost_users WHERE id=$1`, [id]);
  await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.end();
}