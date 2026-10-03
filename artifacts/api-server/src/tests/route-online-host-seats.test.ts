import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import app from "../app.js";
import { createGameState } from "../lib/gameEngine.js";
import { withGameMutationLocks, storeGame, invalidateGameCaches, getPlayerIndexForToken } from "../lib/gameStore.js";
import { runStartupMigrations } from "../lib/analyticsStore.js";
import { coverHumanSeat } from "../lib/playerCover.js";
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
const gameId = `host-seat-test-${randomUUID()}`, hostId = `${gameId}-host`, otherId = `${gameId}-other`;
const token = `${gameId}-seat0`, guestToken = `${gameId}-seat1`, thirdToken = `${gameId}-seat2`;
const userToken = `${gameId}-account`, otherAccount = `${gameId}-other-account`;
async function act(type: string, extra: Record<string, unknown> = {}) {
  const r = await fetch(`${base}/games/${gameId}/action`, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, playerId: "player_0", data: { playerId: "player_1" }, token, userToken, ...extra }),
    signal: AbortSignal.timeout(10000) });
  return { status: r.status, data: await r.json() as any };
}
try {
  await runStartupMigrations();
  for (const id of [hostId, otherId]) await pool.query(`INSERT INTO compost_users(id,email,name) VALUES($1,$2,$1)`, [id, `${id}@test.invalid`]);
  await pool.query(`INSERT INTO compost_user_sessions(token,user_id) VALUES($1,$2),($3,$4)`, [userToken, hostId, otherAccount, otherId]);
  await withGameMutationLocks([gameId], async client => {
    await storeGame({ ...createGameState(gameId, ["Host", "Sam", "Alex"], "online"), facilitatorId: hostId }, client);
    await client.query(`INSERT INTO compost_game_tokens(game_id,token,player_index) VALUES($1,$2,0),($1,$3,1),($1,$4,2)`, [gameId, token, guestToken, thirdToken]);
  });
  for (const invalid of [{ token: undefined }, { userToken: undefined }, { userToken: otherAccount }, { token: guestToken, playerId: "player_1" }]) {
    assert.equal((await act("cover_player", invalid)).status, 403);
    assert.equal((await act("remove_player", invalid)).status, 403);
  }
  const covered = await act("cover_player");
  assert.equal(covered.status, 200);
  assert.equal(covered.data.players[1].botCovering, true);
  assert.equal(covered.data.players[1].botCoverReason, "host");
  assert.equal(await getPlayerIndexForToken(gameId, guestToken), 1, "cover retains the credential");
  assert.equal((await act("take_back_seat", { token: guestToken, playerId: "player_1" })).status, 200);
  await act("cover_player");
  const removed = await act("remove_player");
  assert.equal(removed.status, 200);
  assert.equal(removed.data.players.length, 3);
  assert.equal(removed.data.players[1].isBot, true);
  assert.equal(removed.data.players[1].botCovering, false);
  assert.equal(await getPlayerIndexForToken(gameId, guestToken), null);
  assert.equal(await getPlayerIndexForToken(gameId, thirdToken), 2, "permanent replacement never renumbers another seat");
  assert.equal((await act("take_back_seat", { token: guestToken, playerId: "player_1" })).status, 403);
  await withGameMutationLocks([gameId], client => storeGame(coverHumanSeat({
    ...createGameState(gameId, ["Host", "Sam", "Alex"], "online"), facilitatorId: hostId,
  }, "player_0"), client));
  assert.equal((await act("cover_player", { data: { playerId: "player_2" } })).status, 200, "a covered host still owns host controls");
  assert.equal((await act("take_back_seat", { playerId: "player_0" })).status, 200);
  console.log("route-online-host-seats.test.ts: host credentials, reversible cover, permanent revoke, stable seats and covered host passed");
} finally {
  invalidateGameCaches(gameId);
  await pool.query(`DELETE FROM compost_game_tokens WHERE game_id=$1`, [gameId]);
  await pool.query(`DELETE FROM compost_games WHERE game_id=$1`, [gameId]);
  await pool.query(`DELETE FROM compost_users WHERE id=ANY($1::text[])`, [[hostId, otherId]]);
  await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.end();
}