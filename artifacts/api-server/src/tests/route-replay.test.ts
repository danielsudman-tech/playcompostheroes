import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Response } from "express";
import { pool } from "@workspace/db";
import app from "../app.js";
import { runStartupMigrations } from "../lib/analyticsStore.js";
import { launchGame, type GameState } from "../lib/gameEngine.js";
import {
  addSseClient, broadcastToGame, createSpectatorHostToken, getGame,
  invalidateGameCaches, storeGame, withGameMutationLocks,
  removeSseClient, getConnectedPlayerIds,
} from "../lib/gameStore.js";
import { restartFinishedGame } from "../lib/gameReplay.js";
import { serializeState } from "../routes/game.js";
import { disarmTurnTimer } from "../lib/turnTimerRuntime.js";

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
const suffix = randomUUID();
const hostId = `replay-host-${suffix}`, guestId = `replay-guest-${suffix}`;
const userToken = `${hostId}-session`, guestUserToken = `${guestId}-session`;
const games: string[] = [], events: string[] = [];
const retainFixtures = process.argv.includes("--browser-fixture");
let succeeded = false;
async function request(path: string, body?: object) {
  const response = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, data: await response.json() as any };
}
async function finish(gameId: string) {
  return withGameMutationLocks([gameId], async client => {
    const state = (await getGame(gameId, client))!;
    const active = state.phase === "waiting" ? launchGame(state).state : state;
    const done: GameState = {
      ...active, phase: "game_over", winner: active.players[0].id,
      endedAt: Date.now(), paused: false, pendingDecision: null,
    };
    await storeGame(done, client);
    broadcastToGame(gameId, done, serializeState, client);
    return done;
  });
}
function watch(gameId: string, token: string, index: number, id: string) {
  const frames: any[] = [];
  addSseClient(gameId, token, {
    write: (frame: string) => {
      const data = frame.match(/^data: (.+)$/m)?.[1];
      if (data) frames.push(JSON.parse(data));
      return true;
    },
    end: () => {},
  } as unknown as Response, index, id);
  return frames;
}
function verifyPrivateHands(snapshot: any, viewer: number) {
  assert.ok(snapshot.players[viewer].hand.length > 0);
  snapshot.players.forEach((player: any, index: number) => {
    assert.equal(player.hand.every((card: any) => card.id === "back"), index !== viewer);
  });
  assert.equal("analyticsRoundId" in snapshot, false);
}
try {
  await runStartupMigrations();
  for (const [id, token, role] of [[hostId, userToken, "facilitator"], [guestId, guestUserToken, "player"]]) {
    await pool.query(`INSERT INTO compost_users(id,email,name,role,role_approved_at)
      VALUES($1,$2,'Replay tester',$3,NOW())`, [id, `${id}@test.invalid`, role]);
    await pool.query(`INSERT INTO compost_user_sessions(token,user_id) VALUES($1,$2)`, [token, id]);
  }
  const created = await request("/games", { mode: "online", hostName: "Host", userToken, turnTimerSeconds: 30 });
  assert.equal(created.status, 201);
  const gameId = created.data.gameId, token = created.data.creatorToken;
  games.push(gameId);
  const joined = await request(`/games/${gameId}/join`, { name: "Guest", userToken: guestUserToken });
  assert.equal(joined.status, 201);
  const guestToken = joined.data.token;
  const initial = (await getGame(gameId))!;
  const hostFrames = watch(gameId, token, 0, initial.players[0].id);
  const guestFrames = watch(gameId, guestToken, 1, initial.players[1].id);
  const resetBody = { type: "reset_game", token, userToken, playerId: initial.players[0].id };
  const readyBody = { type: "set_replay_ready", token: guestToken,
    playerId: initial.players[1].id, ready: true, roundNumber: 1 };
  const readyPath = `/games/${gameId}/action`;
  assert.equal((await request(readyPath, readyBody)).status, 409, "no readiness while waiting");
  assert.equal((await request(`/games/${gameId}/action`, resetBody)).status, 409, "cannot discard an unfinished round");
  const completed = await finish(gameId);
  assert.equal((await request(readyPath, { ...readyBody, token: "invalid" })).status, 403);
  assert.equal((await request(readyPath, { ...readyBody, playerId: initial.players[0].id })).status, 403);
  assert.equal((await request(readyPath, { ...readyBody, ready: "true" })).status, 400);
  assert.equal((await request(readyPath, { ...readyBody, roundNumber: 0 })).status, 409);
  const readyResult = await request(readyPath, readyBody);
  assert.equal(readyResult.status, 200, JSON.stringify(readyResult.data));
  assert.deepEqual(readyResult.data.replayReadyPlayerIds, [readyBody.playerId]);
  assert.deepEqual(hostFrames.at(-1).replayReadyPlayerIds, [readyBody.playerId]);
  assert.deepEqual(guestFrames.at(-1).replayReadyPlayerIds, [readyBody.playerId]);
  assert.deepEqual((await request(`/games/${gameId}?token=${guestToken}`)).data.replayReadyPlayerIds, [readyBody.playerId],
    "reconnect/reload rehydrates readiness");
  removeSseClient(gameId, guestToken);
  assert.equal(getConnectedPlayerIds(gameId).includes(readyBody.playerId), false);
  assert.deepEqual((await request(`/games/${gameId}?token=${token}`)).data.replayReadyPlayerIds, [readyBody.playerId],
    "disconnect does not erase the participant's explicit choice");
  watch(gameId, guestToken, 1, readyBody.playerId);
  assert.equal(getConnectedPlayerIds(gameId).includes(readyBody.playerId), true);
  const concurrentReady = await Promise.all([
    request(readyPath, readyBody),
    request(readyPath, { ...readyBody, token, playerId: initial.players[0].id }),
  ]);
  assert.ok(concurrentReady.every(result => result.status === 200));
  assert.equal((await getGame(gameId))!.replayReadyPlayerIds?.length, 2, "concurrent ready updates do not overwrite seats");
  assert.equal((await request(readyPath, { ...readyBody, ready: false })).status, 200);
  assert.deepEqual(hostFrames.at(-1).replayReadyPlayerIds, [initial.players[0].id]);
  const priorLedger = (await pool.query(`SELECT * FROM compost_game_analytics WHERE game_id=$1`, [gameId])).rows[0];
  assert.equal((await request(`/games/${gameId}/action`, {
    type: "reset_game", token: guestToken, userToken: guestUserToken, playerId: initial.players[1].id,
  })).status, 403);
  assert.equal((await request(`/games/${gameId}/action`, { ...resetBody, userToken: guestUserToken })).status, 403);
  const reset = await request(`/games/${gameId}/action`, resetBody);
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.equal(reset.data.gameId, gameId);
  assert.equal(reset.data.roundNumber, 2);
  assert.deepEqual(reset.data.replayReadyPlayerIds, [], "new round clears readiness");
  assert.equal((await request(readyPath, readyBody)).status, 409, "cannot ready during a round");
  assert.equal(reset.data.roundHistory.length, 1);
  assert.equal(reset.data.roundHistory[0].winnerName, "Host");
  assert.deepEqual(reset.data.players.map((p: any) => p.id), completed.players.map(p => p.id));
  assert.equal(reset.data.turnTimerSeconds, 30);
  assert.equal(reset.data.createdAt, completed.createdAt);
  assert.equal(reset.data.players.every((p: any) => p.compostPile.length === 0), true);
  assert.equal(reset.data.discardPile.length, 0);
  assert.equal(reset.data.pendingDecision, null);
  verifyPrivateHands(reset.data, 0);
  verifyPrivateHands(hostFrames.at(-1), 0);
  verifyPrivateHands(guestFrames.at(-1), 1);
  assert.equal("hand" in reset.data.roundHistory[0].standings[0], false);
  const newLedger = (await pool.query(`SELECT * FROM compost_game_analytics WHERE game_id=$1`, [`${gameId}:round:2`])).rows[0];
  assert.equal(newLedger.started, true);
  assert.ok(newLedger.started_at);
  assert.equal(newLedger.ended_at, null);
  assert.equal(newLedger.first_turn_at, null);
  assert.equal((await pool.query(`SELECT ended_at FROM compost_game_analytics WHERE game_id=$1`, [gameId])).rows[0].ended_at.getTime(),
    priorLedger.ended_at.getTime(), "finished-round timing is not overwritten");
  await finish(gameId);
  const racing = await Promise.all([request(`/games/${gameId}/action`, resetBody), request(`/games/${gameId}/action`, resetBody)]);
  assert.deepEqual(racing.map(r => r.status).sort(), [200, 409]);
  assert.equal((await getGame(gameId))!.roundHistory?.length, 2);

  // Preserve permanent and temporary bot seats, stable IDs, skills and ownership.
  const botSource = structuredClone(completed);
  botSource.players[0].id = "stable-host";
  botSource.players[1] = { ...botSource.players[1], id: "stable-guest", isBot: true, botSkillLevel: "hard", botCovering: true, botCoverReason: "host" };
  botSource.winner = botSource.players[0].id;
  const botReplay = restartFinishedGame(botSource);
  assert.equal(botReplay.players[1].id, "stable-guest");
  assert.equal(botReplay.players[1].botCovering, true);
  assert.equal(botReplay.players[1].botSkillLevel, "hard");
  assert.equal(botReplay.facilitatorId, hostId);

  const event = await request("/facilitator/events", { userToken, name: "Replay event", tableCount: 1 });
  assert.equal(event.status, 201, JSON.stringify(event.data));
  const eventId = event.data.eventId, eventGame = event.data.tables[0].gameId;
  events.push(eventId); games.push(eventGame);
  const eventSeats: any[] = [];
  for (const name of ["Guest One", "Guest Two"]) {
    const seat = await request(`/events/${event.data.code}/join`, { name });
    assert.equal(seat.status, 201, JSON.stringify(seat.data));
    eventSeats.push(seat.data);
  }
  await pool.query(`UPDATE compost_event_seats SET ready=true WHERE game_id=$1`, [eventGame]);
  await pool.query(`UPDATE compost_events SET status='active' WHERE id=$1`, [eventId]);
  await finish(eventGame);
  const hostToken = await createSpectatorHostToken(eventGame);
  const eventState = (await getGame(eventGame))!;
  const eventReady = { type: "set_replay_ready", playerId: eventState.players[0].id,
    token: eventSeats[0].token, ready: true, roundNumber: 1 };
  assert.deepEqual(serializeState(eventState, -1).replayReadyPlayerIds, [],
    "waiting-room ready flags never become replay readiness");
  assert.equal((await request(`/games/${eventGame}/action`, { ...eventReady, token: hostToken })).status, 403,
    "spectator host is not a participant");
  assert.equal((await request(`/games/${eventGame}/action`, eventReady)).status, 200);
  await withGameMutationLocks([eventGame], async client => {
    const covered = (await getGame(eventGame, client))!;
    covered.players[0] = { ...covered.players[0], isBot: true, botCovering: true, botCoverReason: "host" };
    await storeGame(covered, client);
  });
  assert.equal((await request(`/games/${eventGame}/action`, { ...eventReady, ready: false })).status, 200,
    "covered humans may still toggle their own readiness");
  assert.equal((await request(`/games/${eventGame}/action`, eventReady)).status, 200);
  const eventDetail = await request(`/facilitator/events/${eventId}?userToken=${userToken}`);
  assert.equal(eventDetail.status, 200, JSON.stringify(eventDetail.data));
  assert.equal(eventDetail.data.tables[0].players[0].replayReady, true);
  assert.equal(eventDetail.data.tables[0].players[0].botCovering, true);
  assert.equal(eventDetail.data.tables[0].players[0].connected, false);
  const eventBody = { type: "reset_game", playerId: "host", token: hostToken, userToken };
  const eventReplay = await request(`/games/${eventGame}/action`, eventBody);
  assert.equal(eventReplay.status, 200, JSON.stringify(eventReplay.data));
  assert.equal(eventReplay.data.roundNumber, 2);
  assert.deepEqual(eventReplay.data.replayReadyPlayerIds, []);
  assert.equal(eventReplay.data.eventId, eventId);
  assert.equal(eventReplay.data.players.every((p: any) => p.hand.every((c: any) => c.id === "back")), true, "spectator never sees hands");
  await finish(eventGame);
  assert.equal((await request(`/games/${eventGame}/action`, eventReady)).status, 409, "stale round readiness is rejected");
  const tablePath = `/facilitator/events/${eventId}/tables/${eventGame}/control`;
  assert.equal((await request(tablePath, { userToken: guestUserToken, action: "restart" })).status, 403);
  const dashboardReplay = await request(tablePath, { userToken, action: "restart" });
  assert.equal(dashboardReplay.status, 200);
  assert.equal(dashboardReplay.data.success, true);
  assert.equal((await getGame(eventGame))!.roundNumber, 3);
  await finish(eventGame);
  for (const status of ["ending", "completed"]) {
    await pool.query(`UPDATE compost_events SET status=$2 WHERE id=$1`, [eventId, status]);
    assert.equal((await request(`/games/${eventGame}/action`, eventBody)).status, 409);
    assert.equal((await request(`/games/${eventGame}/action`, { ...eventReady, roundNumber: 3 })).status, 409);
    assert.equal((await request(tablePath, { userToken, action: "restart" })).status, 409);
  }
  assert.equal((await getGame(eventGame))!.roundHistory?.length, 2);
  if (retainFixtures) {
    const fixtureState = await finish(gameId);
    await writeFile("/tmp/play-again-fixture.json", JSON.stringify({
      userToken, guestUserToken, hostId, guestId, gameId, token, guestToken, eventId,
      roundNumber: fixtureState.roundNumber ?? 1,
    }));
  }
  succeeded = true;
  console.log("route-replay: readiness toggles, concurrent clients, rehydration, covered seats, round isolation, host authorization, regular/event replay, closed events, privacy and round analytics passed");
} finally {
  for (const id of games) { disarmTurnTimer(id); invalidateGameCaches(id); }
  if (!retainFixtures || !succeeded) {
    for (const id of events) await pool.query(`DELETE FROM compost_events WHERE id=$1`, [id]);
    for (const id of games) {
      await pool.query(`DELETE FROM compost_game_tokens WHERE game_id=$1`, [id]);
      await pool.query(`DELETE FROM compost_games WHERE game_id=$1`, [id]);
      await pool.query(`DELETE FROM compost_game_analytics WHERE game_id=ANY($1::text[])`, [[id, `${id}:round:2`, `${id}:round:3`]]);
    }
    await pool.query(`DELETE FROM compost_users WHERE id=ANY($1::text[])`, [[hostId, guestId]]);
  }
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.end();
}
