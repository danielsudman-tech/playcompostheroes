/**
 * Route-level facilitated kick regression: host authorization, token revocation,
 * and bot takeover from both draw and play with a pending decision.
 *
 * Run with: pnpm --filter @workspace/api-server run test:route-facilitated-kick
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import app from "../app.js";
import { createGameState } from "../lib/gameEngine.js";
import {
  claimSlot,
  createSpectatorHostToken,
  getGame,
  getPlayerIndexForToken,
  storeGame,
} from "../lib/gameStore.js";

const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/api`;
const suffix = randomUUID();
const userId = `facilitated-kick-test-${suffix}`;
const userToken = `facilitated-kick-session-${suffix}`;
const gameIds: string[] = [];

async function removePlayer(gameId: string, playerId: string, body: unknown) {
  const response = await fetch(`${base}/games/${gameId}/players/${playerId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as any };
}

async function prepareGame(
  phase: "draw" | "play",
  withPendingDecision = false,
) {
  const gameId = `facilitated-kick-${randomUUID()}`;
  gameIds.push(gameId);
  const state = createGameState(gameId, ["Participant A", "Participant B"], "facilitated");
  state.phase = "waiting";
  state.facilitatorId = userId;
  state.hostIsSpectator = true;
  await storeGame(state);

  const hostToken = await createSpectatorHostToken(gameId);
  const firstSeat = await claimSlot(gameId);
  const targetSeat = await claimSlot(gameId);
  assert.ok(firstSeat && targetSeat);
  const targetToken = targetSeat.token;

  state.phase = phase;
  state.currentPlayerIndex = 1;
  if (phase === "play") {
    state.players[1].hand = [];
    state.players[1].botSkillLevel = "easy";
  }
  if (withPendingDecision) {
    state.pendingDecision = {
      type: "choose_target_player",
      playerId: "player_1",
      cardId: "kick-pending-choice",
      options: [{ playerId: "player_0" }],
      prompt: "Choose a player",
    };
  }
  await storeGame(state);
  return { gameId, hostToken, participantToken: firstSeat.token, targetToken };
}

try {
  await pool.query(
    `INSERT INTO compost_users (id, email, name, role, role_approved_at)
     VALUES ($1, $2, $3, 'facilitator', NOW())`,
    [userId, `${suffix}@example.test`, "Kick Test Facilitator"],
  );
  await pool.query(
    `INSERT INTO compost_user_sessions (token, user_id) VALUES ($1, $2)`,
    [userToken, userId],
  );

  const drawGame = await prepareGame("draw");
  const wrongSeat = await removePlayer(drawGame.gameId, "player_1", {
    token: drawGame.participantToken,
    userToken,
  });
  assert.equal(wrongSeat.status, 403, "participant token cannot authorize facilitator kick");

  const missingAccountToken = await removePlayer(drawGame.gameId, "player_1", {
    token: drawGame.hostToken,
  });
  assert.equal(missingAccountToken.status, 403, "host seat token alone is insufficient");

  const drawKick = await removePlayer(drawGame.gameId, "player_1", {
    token: drawGame.hostToken,
    userToken,
  });
  assert.equal(drawKick.status, 200, JSON.stringify(drawKick.json));
  assert.equal(drawKick.json.success, true);
  const drawState = (await getGame(drawGame.gameId))!;
  assert.equal(drawState.players[1].id, "player_1");
  assert.equal(drawState.players[1].isBot, true);
  assert.equal(await getPlayerIndexForToken(drawGame.gameId, drawGame.targetToken), null);
  assert.equal(await claimSlot(drawGame.gameId, drawGame.targetToken), null);
  assert.equal(await claimSlot(drawGame.gameId), null, "active bot seat cannot get a fresh token");
  assert.ok(drawState.log.some((line) => /taken over by a bot/i.test(line)));

  const playGame = await prepareGame("play", true);
  const playKick = await removePlayer(playGame.gameId, "player_1", {
    token: playGame.hostToken,
    userToken,
  });
  assert.equal(playKick.status, 200, JSON.stringify(playKick.json));
  const playState = (await getGame(playGame.gameId))!;
  assert.equal(playState.players[1].id, "player_1");
  assert.equal(playState.players[1].isBot, true);
  assert.equal(playState.pendingDecision, null, "kicked player's pending decision is bot-resolved");
  assert.notEqual(playState.phase, "play", "the taken-over play turn must not stall");
  assert.equal(await getPlayerIndexForToken(playGame.gameId, playGame.targetToken), null);

  console.log("route-facilitated-kick.test.ts: all assertions passed ✔");
} finally {
  for (const gameId of gameIds) {
    await pool.query(`DELETE FROM compost_game_tokens WHERE game_id = $1`, [gameId]);
    await pool.query(`DELETE FROM compost_games WHERE game_id = $1`, [gameId]);
  }
  await pool.query(`DELETE FROM compost_user_sessions WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM compost_users WHERE id = $1`, [userId]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
}