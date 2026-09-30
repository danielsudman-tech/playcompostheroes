import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import app from "../app.js";
import { getGame, storeGame } from "../lib/gameStore.js";

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
const suffix = randomUUID();
const userId = `event-test-${suffix}`;
const userToken = `event-session-${suffix}`;
const otherId = `event-other-${suffix}`;
const otherToken = `event-other-session-${suffix}`;
const eventIds: string[] = [];
const gameIds: string[] = [];

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, json: await response.json() as any };
}
function post(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

try {
  for (const [id, token, email] of [
    [userId, userToken, `${suffix}@event-test.test`],
    [otherId, otherToken, `${suffix}@event-other.test`],
  ]) {
    await pool.query(
      `INSERT INTO compost_users (id,email,name,role,role_approved_at) VALUES ($1,$2,$3,'facilitator',NOW())`,
      [id, email, id],
    );
    await pool.query(`INSERT INTO compost_user_sessions(token,user_id) VALUES($1,$2)`, [token, id]);
  }
  const created = await request("/facilitator/events", post({
    userToken, name: "Concurrent Join Check", tableCount: 1, tableCapacities: [2],
  }));
  assert.equal(created.status, 201);
  const eventId = created.json.eventId as string;
  const gameId = created.json.tables[0].gameId as string;
  const code = (created.json.code as string).toLowerCase();
  eventIds.push(eventId);
  gameIds.push(gameId);
  assert.equal(created.json.assignmentMode, "auto");
  assert.ok(created.json.hostTokens[gameId], "creation returns reserved host spectator token");
  const publicWaiting = await request(`/events/${code}`);
  assert.equal(publicWaiting.status, 200, "public event lookup accepts lowercase codes");
  assert.equal(publicWaiting.json.tables[0].phase, "waiting", "public table status includes its waiting phase");
  assert.deepEqual(Object.keys(publicWaiting.json.tables[0]).sort(), ["capacity", "occupied", "phase", "tableNumber"]);
  assert.equal((await request(`/events/${code}/join`, post({ name: "Choice rejected", tableNumber: 1 }))).status, 400,
    "auto assignment rejects an explicit table choice");

  const attempts = await Promise.all([
    request(`/events/${code}/join`, post({ name: "Guest 1" })),
    request(`/events/${code}/join`, post({ name: "Guest 2" })),
    request(`/events/${code}/join`, post({ name: "Guest 3" })),
  ]);
  assert.equal(attempts.filter((r) => r.status === 201).length, 2, "two concurrent seats are allocated exactly once");
  assert.equal(attempts.filter((r) => r.status === 409).length, 1, "third concurrent guest cannot overfill the table");
  const directJoin = await request(`/games/${gameId}/join`, post({ name: "Bypass" }));
  assert.equal(directJoin.status, 409, "event games cannot be joined through the direct game route");

  const acceptedSeats = attempts.filter((r) => r.status === 201);
  const notReadyStart = await request(`/facilitator/events/${eventId}/control`, post({ userToken, action: "start" }));
  assert.equal(notReadyStart.json.results[0].success, false, "table cannot start before guests are ready");
  await request(`/events/${code}/ready`, post({ token: acceptedSeats[0].json.token, ready: true }));
  await request(`/events/${code}/presence`, post({ token: acceptedSeats[0].json.token }));
  const oneReadyStart = await request(`/facilitator/events/${eventId}/control`, post({ userToken, action: "start" }));
  assert.equal(oneReadyStart.json.results[0].success, false, "every seated guest must be ready");
  for (const result of acceptedSeats) {
    await request(`/events/${code}/ready`, post({ token: result.json.token, ready: true }));
    await request(`/events/${code}/presence`, post({ token: result.json.token }));
  }
  const started = await request(`/facilitator/events/${eventId}/control`, post({ userToken, action: "start" }));
  assert.equal(started.json.results[0].success, true, "fully ready and connected tables start");

  const denied = await request(`/facilitator/events/${eventId}?userToken=${otherToken}`);
  assert.equal(denied.status, 403, "another approved facilitator cannot access this event");
  const state = await getGame(gameId);
  assert.ok(state);
  state!.phase = "draw";
  state!.pendingDecision = {
    type: "choose_card_from_hand",
    playerId: state!.players[0].id,
    cardId: "event-test-card",
    options: [{ cardId: "secret-hidden-card", cardName: "Do not expose this" }],
    prompt: "Choose a card",
  };
  state!.questions = [{
    id: "q-test", playerId: state!.players[0].id, playerName: state!.players[0].name,
    text: "Need a hand?", ts: Date.now(), resolved: false,
  }];
  await storeGame(state!);
  const detail = await request(`/facilitator/events/${eventId}?userToken=${userToken}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.tables[0].pendingDecisionOwner, state!.players[0].name);
  assert.equal(detail.json.tables[0].questions[0].text, "Need a hand?");
  assert.equal(typeof detail.json.tables[0].players[0].lastSeenAt, "number", "host player detail includes heartbeat time in epoch milliseconds");
  assert.equal(JSON.stringify(detail.json).includes("secret-hidden-card"), false, "event summary never serializes pending decision options");
  assert.equal(JSON.stringify(detail.json).includes('"pendingDecision":'), false, "event summary omits the raw pending decision object");

  const publicActive = await request(`/events/${code}`);
  assert.equal(publicActive.json.status, "active", "public lookup reports active event status");
  assert.equal(publicActive.json.tables[0].phase, "draw", "public table reports the actual active game phase");
  assert.equal(JSON.stringify(publicActive.json).includes("Guest"), false, "public event response omits player names");
  for (const forbidden of ["playerName", "playerId", "players", "questions", "pendingDecision", "cardId", "token", "hostTokens", "hand"]) {
    assert.equal(JSON.stringify(publicActive.json).includes(forbidden), false, `public event response omits ${forbidden}`);
  }
  await pool.query(`UPDATE compost_event_seats SET last_seen_at=NULL WHERE event_id=$1 AND player_id=$2`, [eventId, state!.players[0].id]);
  const neverSeenDetail = await request(`/facilitator/events/${eventId}?userToken=${userToken}`);
  assert.equal(neverSeenDetail.json.tables[0].players.find((p: any) => p.playerId === state!.players[0].id).lastSeenAt, null,
    "host detail distinguishes a guest who has never been seen");

  const naturalWinnerId = state!.players[0].id;
  state!.phase = "game_over";
  state!.winner = naturalWinnerId;
  state!.endedAt = 12345;
  await storeGame(state!);
  const ended = await request(`/facilitator/events/${eventId}/control`, post({ userToken, action: "end" }));
  assert.equal(ended.json.results[0].success, true);
  const preservedWinner = await getGame(gameId);
  assert.equal(preservedWinner?.winner, naturalWinnerId, "host end preserves a naturally finished table's winner");
  assert.equal(preservedWinner?.endedAt, 12345, "host end preserves a naturally finished table's end timestamp");
  assert.equal((await request(`/events/${code}/ready`, post({ token: attempts.find((r) => r.status === 201)!.json.token, ready: false }))).status, 409,
    "readiness cannot change after event completion");
  assert.equal((await request(`/events/${code}/join`, post({ name: "Late Guest" }))).status, 409);
  const publicFinished = await request(`/events/${code}`);
  assert.equal(publicFinished.json.status, "completed", "lowercase code resolves completed event too");
  assert.equal(publicFinished.json.tables[0].phase, "game_over", "public table reports its finished phase");
  assert.equal(JSON.stringify(publicFinished.json).includes("playerName"), false, "finished public results remain privacy-safe");
  const resumed = await request(`/events/${code}/join`, post({ name: "Guest 1", existingToken: attempts.find((r) => r.status === 201)!.json.token }));
  assert.equal(resumed.status, 200, "existing seat can be resumed after event completion");

  const chooseEvent = await request("/facilitator/events", post({
    userToken, name: "Choose and Active Join", tableCount: 2,
    tableCapacities: [2, 2], assignmentMode: "choose",
  }));
  assert.equal(chooseEvent.status, 201);
  const chooseId = chooseEvent.json.eventId as string;
  const chooseCode = (chooseEvent.json.code as string).toLowerCase();
  const firstGameId = chooseEvent.json.tables[0].gameId as string;
  eventIds.push(chooseId);
  gameIds.push(...chooseEvent.json.tables.map((table: any) => table.gameId));
  assert.equal(chooseEvent.json.assignmentMode, "choose");
  const explicitJoins = await Promise.all([
    request(`/events/${chooseCode}/join`, post({ name: "Chosen A", tableNumber: 1 })),
    request(`/events/${chooseCode}/join`, post({ name: "Chosen B", tableNumber: 1 })),
  ]);
  assert.ok(explicitJoins.every((r) => r.status === 201), "choose mode honors explicit table selection");
  for (const result of explicitJoins) {
    await request(`/events/${chooseCode}/ready`, post({ token: result.json.token, ready: true }));
    await request(`/events/${chooseCode}/presence`, post({ token: result.json.token }));
  }
  const partialStart = await request(`/facilitator/events/${chooseId}/control`, post({ userToken, action: "start" }));
  assert.equal(partialStart.json.results[0].success, true);
  assert.equal(partialStart.json.results[1].success, false, "not-ready tables remain waiting");
  const fallbackJoin = await request(`/events/${chooseCode}/join`, post({ name: "Balanced Fallback" }));
  assert.equal(fallbackJoin.status, 201, "active event accepts guests in a waiting table");
  assert.equal(fallbackJoin.json.tableNumber, 2, "choose mode without a table uses balanced available-room fallback");
  const directChoice = await request(`/events/${chooseCode}/join`, post({ name: "Table Two", tableNumber: 2 }));
  assert.equal(directChoice.status, 201, "choose mode permits explicit selection while active");
  const left = await request(`/games/${chooseEvent.json.tables[1].gameId}/players/${directChoice.json.playerId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: directChoice.json.token }),
  });
  assert.equal(left.status, 200, "event guest can leave a waiting table");
  const replacement = await request(`/events/${chooseCode}/join`, post({ name: "Kick Target", tableNumber: 2 }));
  assert.equal(replacement.status, 201);
  const kicked = await request(`/games/${chooseEvent.json.tables[1].gameId}/players/${replacement.json.playerId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: chooseEvent.json.hostTokens[chooseEvent.json.tables[1].gameId],
      userToken,
    }),
  });
  assert.equal(kicked.status, 200, "event host can kick a waiting guest");
  const leftFallback = await request(`/games/${chooseEvent.json.tables[1].gameId}/players/${fallbackJoin.json.playerId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: fallbackJoin.json.token }),
  });
  assert.equal(leftFallback.status, 200);
  const remainingSeats = await pool.query(
    `SELECT player_id FROM compost_event_seats WHERE event_id=$1 AND game_id=$2`,
    [chooseId, chooseEvent.json.tables[1].gameId],
  );
  assert.equal(remainingSeats.rows.length, 0, `leave and kick remove event seat records: ${JSON.stringify({
    remaining: remainingSeats.rows, leftPlayer: directChoice.json.playerId, kickedPlayer: replacement.json.playerId,
    fallbackPlayer: fallbackJoin.json.playerId,
  })}`);
  assert.equal((await request(`/facilitator/events/${chooseId}?userToken=${userToken}`)).json.tables[1].players.length, 0,
    "event guest state and membership stay synchronized after leave/kick");

  const transferEvent = await request("/facilitator/events", post({
    userToken, name: "Atomic Seat Transfer", tableCount: 2,
    tableCapacities: [2, 2], assignmentMode: "choose",
  }));
  const transferEventId = transferEvent.json.eventId as string;
  const transferCode = (transferEvent.json.code as string).toLowerCase();
  const sourceId = transferEvent.json.tables[0].gameId as string;
  const targetId = transferEvent.json.tables[1].gameId as string;
  eventIds.push(transferEventId);
  gameIds.push(sourceId, targetId);
  const transferGuest = await request(`/events/${transferCode}/join`, post({ name: "Transfer Guest", tableNumber: 1 }));
  assert.equal(transferGuest.status, 201);
  const moved = await request(`/games/${sourceId}/waiting/transfer`, post({
    token: transferEvent.json.hostTokens[sourceId], userToken,
    playerId: transferGuest.json.playerId, targetGameId: targetId,
  }));
  assert.equal(moved.status, 200, "guest can transfer between tables in one event");
  const transferDetail = await request(`/facilitator/events/${transferEventId}?userToken=${userToken}`);
  assert.equal(transferDetail.json.tables[0].players.length, 0);
  assert.equal(transferDetail.json.tables[1].players[0].playerId, transferGuest.json.playerId);
  assert.equal(transferDetail.json.tables[1].players[0].ready, false, "moved guest must ready again");
  const crossEventMove = await request(`/games/${targetId}/waiting/transfer`, post({
    token: transferEvent.json.hostTokens[targetId], userToken,
    playerId: transferGuest.json.playerId, targetGameId: chooseEvent.json.tables[1].gameId,
  }));
  assert.equal(crossEventMove.status, 409, "cross-event seat transfer is rejected");

  const perTableEndEvent = await request("/facilitator/events", post({
    userToken, name: "Per-table End Stays Local", tableCount: 2, tableCapacities: [2, 2],
    assignmentMode: "choose",
  }));
  const perTableEndId = perTableEndEvent.json.eventId as string;
  const perTableEndCode = (perTableEndEvent.json.code as string).toLowerCase();
  const endedTableId = perTableEndEvent.json.tables[0].gameId as string;
  const waitingTableId = perTableEndEvent.json.tables[1].gameId as string;
  eventIds.push(perTableEndId);
  gameIds.push(endedTableId, waitingTableId);
  const endOneTable = await request(`/games/${endedTableId}/end`, post({
    token: perTableEndEvent.json.hostTokens[endedTableId], userToken,
  }));
  assert.equal(endOneTable.status, 200);
  assert.equal((await request(`/facilitator/events/${perTableEndId}?userToken=${userToken}`)).json.status, "upcoming",
    "ending one table does not close the whole event");
  const unrelatedJoin = await request(`/events/${perTableEndCode}/join`, post({ name: "Unrelated Waiting Table", tableNumber: 2 }));
  assert.equal(unrelatedJoin.status, 201, "ending one table leaves joins open at other waiting tables");
  const unrelatedControl = await request(`/facilitator/events/${perTableEndId}/tables/${waitingTableId}/control`,
    post({ userToken, action: "pause" }));
  assert.equal(unrelatedControl.status, 200, "ending one table leaves controls enabled on other tables");

  const raceEvent = await request("/facilitator/events", post({
    userToken, name: "Join Start End Race", tableCount: 1, tableCapacities: [4],
  }));
  const raceId = raceEvent.json.eventId as string;
  const raceCode = (raceEvent.json.code as string).toLowerCase();
  const raceGameId = raceEvent.json.tables[0].gameId as string;
  const raceHostToken = raceEvent.json.hostTokens[raceGameId] as string;
  eventIds.push(raceId);
  gameIds.push(raceGameId);
  const firstRaceGuest = await request(`/events/${raceCode}/join`, post({ name: "Race A" }));
  assert.equal(firstRaceGuest.status, 201);
  await request(`/events/${raceCode}/ready`, post({ token: firstRaceGuest.json.token, ready: true }));
  await request(`/events/${raceCode}/presence`, post({ token: firstRaceGuest.json.token }));
  const [raceJoin, raceStart] = await Promise.all([
    request(`/events/${raceCode}/join`, post({ name: "Race B" })),
    request(`/facilitator/events/${raceId}/control`, post({ userToken, action: "start" })),
  ]);
  assert.equal(raceJoin.status, 201);
  assert.equal(raceStart.json.results[0].success, false, "race cannot make an unready table launch");
  assert.equal((await request(`/facilitator/events/${raceId}?userToken=${userToken}`)).json.status, "upcoming",
    "event stays upcoming when no table starts");
  assert.equal((await getGame(raceGameId))?.phase, "waiting", "racing start cannot launch before the new seat is ready");
  const botStart = await request(`/games/${raceGameId}/start`, post({ token: raceHostToken, userToken, botSlots: [{ name: "Bot" }] }));
  assert.equal(botStart.status, 400, "event tables reject botSlots through the direct start route");
  const unreadyDirectStart = await request(`/games/${raceGameId}/start`, post({ token: raceHostToken, userToken }));
  assert.equal(unreadyDirectStart.status, 409, "direct game start also enforces event readiness");
  await request(`/events/${raceCode}/ready`, post({ token: raceJoin.json.token, ready: true }));
  await request(`/events/${raceCode}/presence`, post({ token: raceJoin.json.token }));
  const readyDirectStart = await request(`/games/${raceGameId}/start`, post({ token: raceHostToken, userToken }));
  assert.equal(readyDirectStart.status, 200, "direct start succeeds only after all event guests are ready and connected");
  let directStartStatus = "";
  for (let attempt = 0; attempt < 10 && directStartStatus !== "active"; attempt++) {
    directStartStatus = (await request(`/events/${raceCode}`)).json.status;
    if (directStartStatus !== "active") await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(directStartStatus, "active", "direct game start broadcast activates its event");
  const [lateJoin, closeEvent] = await Promise.all([
    request(`/events/${raceCode}/join`, post({ name: "Race C" })),
    request(`/facilitator/events/${raceId}/control`, post({ userToken, action: "end" })),
  ]);
  assert.ok([201, 409].includes(lateJoin.status), "racing join either commits before close or is rejected after close");
  assert.equal(closeEvent.json.results[0].success, true);
  assert.equal((await getGame(raceGameId))?.phase, "game_over");
  const raceSeatCount = await pool.query(`SELECT COUNT(*) FROM compost_event_seats WHERE event_id=$1`, [raceId]);
  assert.equal(Number(raceSeatCount.rows[0].count), (await getGame(raceGameId))?.players.length,
    "event close leaves joined state and event seat records consistent");
} finally {
  for (const eventId of eventIds) {
    await pool.query(`DELETE FROM compost_events WHERE id=$1`, [eventId]);
  }
  for (const gameId of gameIds) {
    await pool.query(`DELETE FROM compost_game_tokens WHERE game_id=$1`, [gameId]).catch(() => undefined);
    await pool.query(`DELETE FROM compost_games WHERE game_id=$1`, [gameId]).catch(() => undefined);
  }
  await pool.query(`DELETE FROM compost_user_sessions WHERE user_id IN ($1,$2)`, [userId, otherId]);
  await pool.query(`DELETE FROM compost_users WHERE id IN ($1,$2)`, [userId, otherId]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
}