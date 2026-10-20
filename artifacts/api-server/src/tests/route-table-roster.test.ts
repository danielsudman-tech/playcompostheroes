import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Response } from "express";
import { pool } from "@workspace/db";
import app from "../app.js";
import { runStartupMigrations } from "../lib/analyticsStore.js";
import { launchGame, type GameState } from "../lib/gameEngine.js";
import {
  addSseClient, broadcastToGame, createSpectatorHostToken, invalidateGameCaches,
  getGame, getPlayerIndexForToken, storeGame, withGameMutationLocks,
} from "../lib/gameStore.js";
import { serializeState } from "../routes/game.js";
import { disarmTurnTimer } from "../lib/turnTimerRuntime.js";

const suffix = randomUUID();
const hostId = `roster-host-${suffix}`, userToken = `roster-session-${suffix}`;
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
const games: string[] = [], events: string[] = [];
let retained = false;
async function request(path: string, body?: unknown, method = body ? "POST" : "GET") {
  const response = await fetch(base + path, {
    method, headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, data: await response.json() as any };
}
async function makeEvent(tableCount: number) {
  const result = await request("/facilitator/events", {
    userToken, name: `Roster test ${suffix}`, tableCount, assignmentMode: "choose",
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  events.push(result.data.eventId);
  games.push(...result.data.tables.map((table: any) => table.gameId));
  return result.data;
}
async function join(code: string, name: string, tableNumber: number) {
  const result = await request(`/events/${code}/join`, { name, tableNumber });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return { ...result.data, name };
}
async function finish(gameId: string) {
  return withGameMutationLocks([gameId], async client => {
    let state = (await getGame(gameId, client))!;
    if (state.phase === "waiting") state = launchGame(state).state;
    const next: GameState = {
      ...state, phase: "game_over", winner: state.players[0].id,
      paused: false, pendingDecision: null, endedAt: Date.now(),
      replayReadyPlayerIds: state.players.map(player => player.id),
    };
    await storeGame(next, client);
    broadcastToGame(gameId, next, serializeState, client);
    return next;
  });
}
function watch(gameId: string, token: string, index: number, playerId: string) {
  const frames: string[] = [];
  addSseClient(gameId, token, {
    write(chunk: string) { frames.push(String(chunk)); return true; },
    flush() {}, end() {},
  } as unknown as Response, index, playerId);
  return frames;
}
function lastState(frames: string[]) {
  return frames.filter(frame => frame.startsWith("data: ")).map(frame => JSON.parse(frame.slice(6))).at(-1);
}
const transfer = (source: string, token: string, playerId: string, target: string, account = userToken) =>
  request(`/games/${source}/waiting/transfer`, { token, userToken: account, playerId, targetGameId: target });
const remove = (source: string, token: string, playerId: string) =>
  request(`/games/${source}/players/${playerId}`, { token, userToken }, "DELETE");

try {
  await runStartupMigrations();
  await pool.query(`INSERT INTO compost_users(id,email,name,role,role_approved_at)
    VALUES($1,$2,'Roster Host','facilitator',NOW())`, [hostId, `${suffix}@test.invalid`]);
  await pool.query(`INSERT INTO compost_user_sessions(token,user_id) VALUES($1,$2)`, [userToken, hostId]);
  const event = await makeEvent(3);
  const [one, two, three] = event.tables.map((table: any) => table.gameId) as string[];
  const hosts = await Promise.all([one, two, three].map(id => createSpectatorHostToken(id)));
  const a = await join(event.code, "A", 1), b = await join(event.code, "B", 1);
  const c = await join(event.code, "C", 2), d = await join(event.code, "D", 2);
  const e = await join(event.code, "E", 3), f = await join(event.code, "F", 3);

  assert.equal((await transfer(one, hosts[0], b.playerId, two)).status, 200, "waiting event transfer");
  b.playerId = (await request(`/games/${two}/claim`, { token: b.token })).data.playerId;
  assert.equal((await transfer(two, hosts[1], b.playerId, one)).status, 200);
  b.playerId = (await request(`/games/${one}/claim`, { token: b.token })).data.playerId;
  const completedOne = await finish(one), completedTwo = await finish(two);
  const originalBHand = completedOne.players.find(player => player.id === b.playerId)!.hand;
  const aFrames = watch(one, a.token, 0, a.playerId);
  const bFrames = watch(one, b.token, 1, b.playerId);
  const cFrames = watch(two, c.token, 0, c.playerId);
  assert.equal((await transfer(one, hosts[0], a.playerId, two, "not-owner")).status, 403);
  assert.equal((await transfer(one, hosts[0], a.playerId, two)).status, 200, "finished-to-finished transfer");
  assert.ok(aFrames.some(frame => frame.includes("event: room_transfer")));
  const oldClaim = await request(`/games/${one}/claim`, { token: a.token });
  assert.equal(oldClaim.status, 409);
  assert.equal(oldClaim.data.redirectGameId, two, "reconnect redirects to the new table");
  const movedA = (await request(`/games/${two}/claim`, { token: a.token })).data;
  assert.equal(movedA.playerIndex, 2);
  assert.notEqual(movedA.playerId, c.playerId, "colliding player IDs must be remapped");
  assert.equal(await getPlayerIndexForToken(one, b.token), 0);
  assert.deepEqual(lastState(bFrames).players[0].hand, originalBHand);
  assert.ok(lastState(cFrames).players[1].hand.every((card: any) => card.id === "back"));
  assert.deepEqual(lastState(cFrames).players[2].hand, []);
  const archivedOne = (await getGame(one))!;
  const savedOne = structuredClone(archivedOne.roundHistory);
  const savedTwo = structuredClone((await getGame(two))!.roundHistory);
  assert.equal(savedOne?.[0].winnerName, "A");
  assert.deepEqual(savedOne?.[0].standings.map(player => player.name), ["A", "B"]);
  assert.deepEqual(savedTwo?.[0].standings.map(player => player.name), ["C", "D"]);
  assert.deepEqual(archivedOne.replayReadyPlayerIds, []);
  assert.deepEqual((await getGame(two))!.replayReadyPlayerIds, []);
  assert.deepEqual((await getGame(two))!.players[2].compostPile, []);
  const oldFrameCount = aFrames.length;
  broadcastToGame(one, archivedOne, serializeState);
  assert.equal(aFrames.length, oldFrameCount, "moved token gets no more source state");
  const detail = await fetch(`${base}/facilitator/events/${event.eventId}`, { headers: { Authorization: `Bearer ${userToken}` } });
  const summary = await detail.json() as any;
  assert.equal(summary.tables.find((table: any) => table.gameId === one).winner, "A");

  assert.equal((await transfer(three, hosts[2], e.playerId, two)).status, 200, "waiting-to-finished");
  const movedE = (await request(`/games/${two}/claim`, { token: e.token })).data;
  assert.equal((await transfer(three, hosts[2], f.playerId, two)).status, 409, "full destination");
  assert.equal((await transfer(two, hosts[1], movedE.playerId, three)).status, 200, "finished-to-waiting");
  await withGameMutationLocks([three], async client => {
    const state = (await getGame(three, client))!;
    await storeGame(launchGame(state).state, client);
  });
  assert.equal((await transfer(three, hosts[2], f.playerId, one)).status, 409, "no active source");
  assert.equal((await transfer(two, hosts[1], c.playerId, three)).status, 409, "no active destination");
  const other = await makeEvent(1);
  assert.equal((await transfer(two, hosts[1], c.playerId, other.tables[0].gameId)).status, 409, "no cross-event move");

  assert.equal((await remove(one, hosts[0], b.playerId)).status, 200, "remove between rounds");
  assert.ok(bFrames.some(frame => frame.includes("event: kicked")));
  assert.equal((await request(`/games/${one}/claim`, { token: b.token })).status, 403);
  assert.equal((await getGame(one))!.players.length, 0);
  assert.deepEqual((await getGame(one))!.roundHistory, savedOne);
  const revokedFrames = bFrames.length;
  broadcastToGame(one, (await getGame(one))!, serializeState);
  assert.equal(bFrames.length, revokedFrames, "removed token gets no further state");
  assert.equal((await request(`/games/${one}/action`, {
    type: "reset_game", token: hosts[0], userToken, playerId: "host",
  })).status, 409, "cannot restart empty table");
  assert.equal((await transfer(two, hosts[1], c.playerId, one)).status, 200);
  assert.equal((await transfer(two, hosts[1], d.playerId, one)).status, 200);
  assert.deepEqual((await getGame(one))!.roundHistory, savedOne, "editing twice never overwrites results");
  assert.deepEqual((await getGame(two))!.roundHistory, savedTwo);
  const reset = await request(`/games/${one}/action`, {
    type: "reset_game", token: hosts[0], userToken, playerId: "host",
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.deepEqual(reset.data.players.map((player: any) => player.name), ["C", "D"]);
  assert.equal(reset.data.roundNumber, 2);
  assert.deepEqual(reset.data.roundHistory, savedOne, "replay must not duplicate archived round");
  assert.ok(reset.data.players.every((player: any) => player.hand.every((card: any) => card.id === "back")));
  assert.equal((await request(`/games/${two}/action`, {
    type: "reset_game", token: hosts[1], userToken, playerId: "host",
  })).status, 409, "cannot replay one-person table");
  assert.deepEqual((await getGame(two))!.roundHistory?.[0].endedAt, completedTwo.endedAt);
  assert.equal((await getGame(one))!.roundHistory?.[0].endedAt, completedOne.endedAt);
  for (const status of ["ending", "completed"]) {
    await pool.query("UPDATE compost_events SET status=$2 WHERE id=$1", [event.eventId, status]);
    assert.equal((await remove(two, hosts[1], movedA.playerId)).status, 409);
    assert.equal((await transfer(two, hosts[1], movedA.playerId, one)).status, 409);
  }

  if (process.argv.includes("--browser-fixture")) {
    const browserEvent = await makeEvent(2);
    const tables = [];
    for (let index = 0; index < 2; index++) {
      const gameId = browserEvent.tables[index].gameId;
      const guests = [
        await join(browserEvent.code, `Table ${index + 1} Alpha`, index + 1),
        await join(browserEvent.code, `Table ${index + 1} Beta`, index + 1),
      ];
      const hostToken = await createSpectatorHostToken(gameId);
      await finish(gameId);
      tables.push({ gameId, hostToken, guests });
    }
    await writeFile("/tmp/table-roster-fixture.json",
      JSON.stringify({ hostId, userToken, eventId: browserEvent.eventId, code: browserEvent.code, tables }));
    retained = true;
  }
  console.log("route-table-roster: event transfers, ended-round removal, immutable results, token privacy, seat remapping, readiness reset, capacity, active/closed guards and replay passed");
} finally {
  for (const id of games) { disarmTurnTimer(id); invalidateGameCaches(id); }
  if (!retained) {
    await pool.query("DELETE FROM compost_events WHERE id=ANY($1::text[])", [events]);
    await pool.query("DELETE FROM compost_game_tokens WHERE game_id=ANY($1::text[])", [games]);
    await pool.query("DELETE FROM compost_games WHERE game_id=ANY($1::text[])", [games]);
    await pool.query("DELETE FROM compost_game_analytics WHERE split_part(game_id,':round:',1)=ANY($1::text[])", [games]);
    await pool.query("DELETE FROM compost_analytics_events WHERE game_id=ANY($1::text[])", [games]);
    await pool.query("DELETE FROM compost_users WHERE id=$1", [hostId]);
  }
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.end();
}
