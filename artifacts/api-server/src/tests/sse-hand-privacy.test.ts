import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { pool } from "@workspace/db";
import app from "../app.js";
import { createGameState, type GameState } from "../lib/gameEngine.js";
import {
  addSseClient, broadcastToGame, claimSlot, createSpectatorHostToken, getGame,
  evictGameStoreCache, invalidateGameCaches, kickFacilitatedPlayer, removePlayerTokenByIndex, removeSseClient,
  reorderWaitingPlayers, sendKickedEvent, sendRoomTransferEvent, storeGame,
  transferWaitingPlayer, withGameMutationLocks,
} from "../lib/gameStore.js";
import { GameStoreCache } from "../lib/gameStoreCache.js";
import { syncTurnClock } from "../lib/turnClock.js";
import "../lib/turnTimerRuntime.js";
import { serializeState } from "../routes/game.js";

const suffix = randomUUID();
const userId = `sse-privacy-${suffix}`;
const userToken = `sse-session-${suffix}`;
const gameIds: string[] = [];
const eventIds: string[] = [];
const controllers: AbortController[] = [];
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
type Stream = { frames: any[]; events: string[]; token: string; playerId?: string; revoked: boolean };
type Fixture = { state: GameState; streams: Stream[]; hostToken?: string };

async function request(path: string, body: object) {
  const response = await fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  const json = await response.json() as any;
  assert.ok(response.ok, `${path}: HTTP ${response.status}: ${json.error ?? ""}`);
  return json;
}
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function openStream(gameId: string, token: string, playerId?: string): Promise<Stream> {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(`${base}/games/${gameId}/events?token=${encodeURIComponent(token)}`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const stream: Stream = { frames: [], events: [], token, playerId, revoked: false };
  const reader = response.body!.getReader();
  void (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = frame.match(/^event: (.+)$/m)?.[1];
        if (event) stream.events.push(event);
        else {
          const data = frame.match(/^data: (.+)$/m)?.[1];
          if (data) stream.frames.push(JSON.parse(data));
        }
      }
    }
  })().catch(error => {
    if (!controller.signal.aborted) throw error;
  });
  await until(() => stream.frames.length > 0, "initial SSE snapshot");
  return stream;
}
async function fixture(mode: "online" | "facilitated", waiting = false, names = ["A", "B", "C"]): Promise<Fixture> {
  const gameId = `sse-${randomUUID()}`;
  gameIds.push(gameId);
  const state = createGameState(gameId, names, mode);
  state.phase = "waiting";
  state.facilitatorId = userId;
  state.hostIsSpectator = mode === "facilitated";
  state.players.forEach((player, index) => { player.id = `${gameId}-p${index}`; });
  await storeGame(state);
  const hostToken = mode === "facilitated" ? await createSpectatorHostToken(gameId) : undefined;
  const tokens = [];
  for (let index = 0; index < names.length; index++) {
    const seat = await claimSlot(gameId);
    assert.equal(seat?.playerIndex, index);
    tokens.push(seat!.token);
  }
  state.deck.push(...state.players.flatMap(player => player.hand));
  state.players.forEach(player => { player.hand = state.deck.splice(0, 3); });
  state.phase = waiting ? "waiting" : "draw";
  await storeGame(state);
  const streams = [];
  for (let index = 0; index < tokens.length; index++) {
    streams.push(await openStream(gameId, tokens[index], state.players[index].id));
  }
  if (hostToken) streams.push(await openStream(gameId, hostToken));
  return { state, streams, hostToken };
}
function assertHands(f: Fixture, state: GameState) {
  for (const stream of f.streams.filter(stream => !stream.revoked)) {
    const frame = stream.frames.at(-1)!;
    const seat = stream.playerId ? state.players.findIndex(player => player.id === stream.playerId) : -1;
    assert.ok(!stream.playerId || seat >= 0);
    for (let index = 0; index < state.players.length; index++) {
      const actual = frame.players[index].hand;
      if (index === seat) {
        assert.deepEqual(actual.map((card: any) => card.id), state.players[index].hand.map(card => card.id),
          "the viewer's own hand is real, without a subsequent action or fallback GET");
      } else {
        assert.ok(actual.every((card: any) => card.id === "back" && card.type === "unknown"), "all other hands, including spectator views, are hidden");
      }
    }
  }
}
async function checkBroadcast(f: Fixture, action: () => Promise<unknown>, label: string) {
  const active = f.streams.filter(stream => !stream.revoked);
  const counts = active.map(stream => stream.frames.length);
  await action();
  await until(() => active.every((stream, index) => stream.frames.length > counts[index]), label);
  const state = (await getGame(f.state.gameId))!;
  assertHands(f, state);
  f.state = state;
  console.log(`SSE hand privacy: ${label} passed`);
}

try {
  await pool.query(`INSERT INTO compost_users(id,email,name,role,role_approved_at)
    VALUES($1,$2,'SSE Privacy Test','facilitator',NOW())`, [userId, `${suffix}@sse.example.test`]);
  await pool.query(`INSERT INTO compost_user_sessions(token,user_id) VALUES($1,$2)`, [userToken, userId]);

  const timed = await fixture("online");
  const cache = new GameStoreCache<GameState>();
  cache.setState(timed.state);
  cache.setTokenIndex(timed.state.gameId, new Map([["seat", 0]]));
  cache.invalidateState(timed.state.gameId);
  assert.equal(cache.getState(timed.state.gameId), undefined);
  assert.equal(cache.getTokenIndex(timed.state.gameId)?.get("seat"), 0, "state invalidation retains credentials");
  cache.invalidateTokenIndex(timed.state.gameId);
  assert.equal(cache.getTokenIndex(timed.state.gameId), undefined, "token invalidation still revokes the cache");
  await checkBroadcast(timed, async () => {
    timed.state.phase = "play";
    timed.state.turnTimerSeconds = 30;
    Object.assign(timed.state, syncTurnClock(timed.state));
    timed.state.turnDeadlineAt = Date.now() - 1;
    await storeGame(timed.state);
    // The real scheduler expires through its held-client getGame/store/broadcast path.
  }, "real timer expiry");
  assert.ok(timed.state.turnNumber > 0);
  timed.state.turnTimerSeconds = 0;
  await storeGame(timed.state);
  await checkBroadcast(timed, async () => {
    assert.ok(evictGameStoreCache(Date.now() + 24 * 60 * 60 * 1_000, 1_000).includes(timed.state.gameId));
    broadcastToGame(timed.state.gameId, timed.state, serializeState);
  }, "cache eviction preserves each live viewer's hand");

  const online = await fixture("online");
  const act = (type: string, index: number, data?: object) => request(`/games/${online.state.gameId}/action`, {
    type, token: online.streams[index].token, playerId: online.state.players[index].id, data, userToken,
  });
  await checkBroadcast(online, () => act("draw_card", 0), "held-client Online action");
  await checkBroadcast(online, () => act("cover_player", 0, { playerId: online.state.players[1].id }), "Online host bot cover");
  await checkBroadcast(online, () => act("take_back_seat", 1), "covered seat return");
  const removed = online.streams[2];
  const removedFrames = removed.frames.length;
  removed.revoked = true;
  await checkBroadcast(online, () => act("remove_player", 0, { playerId: online.state.players[2].id }), "Online host removal");
  await until(() => removed.events.includes("kicked"), "revoked player kick");
  assert.equal(removed.frames.length, removedFrames);
  await checkBroadcast(online, async () => {
    await withGameMutationLocks([online.state.gameId], async client => {
      const state = (await getGame(online.state.gameId, client))!;
      await storeGame(state, client);
      broadcastToGame(state.gameId, state, serializeState, client);
    });
  }, "subsequent held-client broadcast excludes revoked token");
  assert.equal(removed.frames.length, removedFrames);

  const event = await request("/facilitator/events", { userToken, name: "SSE privacy", tableCount: 1, tableCapacities: [3] });
  eventIds.push(event.eventId);
  const eventGameId = event.tables[0].gameId;
  gameIds.push(eventGameId);
  for (let index = 0; index < 3; index++) await request(`/events/${event.code}/join`, { name: `SSE guest ${index}` });
  const eventState = (await getGame(eventGameId))!;
  eventState.deck.push(...eventState.players.flatMap(player => player.hand));
  eventState.players.forEach(player => { player.hand = eventState.deck.splice(0, 3); });
  eventState.phase = "draw";
  await storeGame(eventState);
  const eventTokens = (await pool.query(`SELECT token,player_index FROM compost_game_tokens WHERE game_id=$1`, [eventGameId])).rows;
  const eventStreams = [];
  for (const row of eventTokens) eventStreams.push(await openStream(eventGameId, row.token, eventState.players[row.player_index]?.id));
  const linked: Fixture = { state: eventState, streams: eventStreams };
  const firstSeat = eventStreams.find(stream => stream.playerId === eventState.players[0].id)!;
  await checkBroadcast(linked, () => request(`/games/${eventGameId}/action`, {
    type: "draw_card", playerId: eventState.players[0].id, token: firstSeat.token,
  }), "Event-linked held-client action and spectator privacy");

  const waiting = await fixture("facilitated", true);
  const ids = waiting.state.players.map(player => player.id);
  await checkBroadcast(waiting, async () => {
    const state = await reorderWaitingPlayers(waiting.state.gameId, [ids[2], ids[0], ids[1]]);
    assert.ok(state);
    broadcastToGame(state.gameId, state, serializeState);
  }, "waiting-room reorder");
  const target = await fixture("facilitated", true, ["D"]);
  evictGameStoreCache(Date.now() + 24 * 60 * 60 * 1_000, 1_000);
  const moved = waiting.streams.find(stream => stream.playerId === ids[0])!;
  const sourceCount = moved.frames.length;
  moved.revoked = true;
  await checkBroadcast(waiting, async () => {
    const result = await transferWaitingPlayer(waiting.state.gameId, target.state.gameId, ids[0]);
    assert.ok(result);
    sendRoomTransferEvent(waiting.state.gameId, result.token, target.state.gameId, result.token);
    broadcastToGame(waiting.state.gameId, result.source, serializeState);
    broadcastToGame(target.state.gameId, result.target, serializeState);
    target.state = result.target;
  }, "transfer shifts source seats and silences the moved source connection");
  await until(() => moved.events.includes("room_transfer"), "transfer event");
  assert.equal(moved.frames.length, sourceCount);
  target.streams.push(await openStream(target.state.gameId, moved.token, ids[0]));
  assertHands(target, target.state);
  console.log("SSE hand privacy: moved token reconnects to its new table seat passed");

  const kicked = target.streams.find(stream => stream.playerId === ids[0])!;
  const kickCount = kicked.frames.length;
  kicked.revoked = true;
  await checkBroadcast(target, async () => {
    const result = await kickFacilitatedPlayer(target.state.gameId, ids[0], target.hostToken!, userId);
    assert.ok(result?.removedToken);
    sendKickedEvent(target.state.gameId, result.removedToken);
    broadcastToGame(target.state.gameId, result.state, serializeState);
  }, "waiting-room kick");
  assert.equal(kicked.frames.length, kickCount);

  const seatRemoved = waiting.streams.find(stream => stream.playerId === ids[2])!;
  seatRemoved.revoked = true;
  await checkBroadcast(waiting, async () => {
    await withGameMutationLocks([waiting.state.gameId], async client => {
      const state = (await getGame(waiting.state.gameId, client))!;
      const token = await removePlayerTokenByIndex(state.gameId, 0, client);
      state.players.splice(0, 1);
      await storeGame(state, client);
      if (token) sendKickedEvent(state.gameId, token);
      broadcastToGame(state.gameId, state, serializeState, client);
    });
  }, "held-client seat removal shifts remaining connection indexes");

  const chunks: string[] = [];
  const unknown = { write: (chunk: string) => { chunks.push(chunk); } } as unknown as Response;
  addSseClient(online.state.gameId, "unknown", unknown);
  addSseClient(online.state.gameId, "mismatched", unknown, 0, "another-player");
  broadcastToGame(online.state.gameId, online.state, (state, index) => {
    assert.notEqual(index, undefined, "unknown viewers must never be serialized");
    return serializeState(state, index);
  });
  assert.deepEqual(chunks, ["event: refresh\ndata: {}\n\n", "event: refresh\ndata: {}\n\n"]);
  removeSseClient(online.state.gameId, "unknown");
  removeSseClient(online.state.gameId, "mismatched");
  console.log("SSE hand privacy: unknown/mismatched seats receive only refresh, no hand data passed");
  chunks.length = 0;
  addSseClient(online.state.gameId, "partial-delete", unknown, 0, online.state.players[0].id);
  let queries = 0;
  await assert.rejects(removePlayerTokenByIndex(online.state.gameId, 0, {
    query: async () => {
      queries++;
      if (queries === 1) return { rows: [{ token: "partial-delete" }] };
      if (queries === 2) return { rows: [] };
      throw new Error("index shift failed after credential deletion");
    },
  }));
  broadcastToGame(online.state.gameId, online.state, serializeState);
  assert.deepEqual(chunks, [], "a partially successful revocation cannot leak subsequent state");
  removeSseClient(online.state.gameId, "partial-delete");
  console.log("SSE hand privacy: partial token mutation failure fails closed passed");
} finally {
  controllers.forEach(controller => controller.abort());
  for (const gameId of gameIds) invalidateGameCaches(gameId);
  for (const eventId of eventIds) await pool.query(`DELETE FROM compost_events WHERE id=$1`, [eventId]);
  for (const gameId of gameIds) {
    await pool.query(`DELETE FROM compost_game_tokens WHERE game_id=$1`, [gameId]);
    await pool.query(`DELETE FROM compost_games WHERE game_id=$1`, [gameId]);
  }
  await pool.query(`DELETE FROM compost_users WHERE id=$1`, [userId]);
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.end();
}