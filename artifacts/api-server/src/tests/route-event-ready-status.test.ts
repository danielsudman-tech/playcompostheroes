import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import app from "../app.js";
import { runStartupMigrations } from "../lib/analyticsStore.js";

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
const suffix = randomUUID();
const userId = `event-ready-test-${suffix}`;
const userToken = `event-ready-session-${suffix}`;
let eventId: string | undefined;
let gameId: string | undefined;

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(20_000),
  });
  return { status: response.status, json: await response.json() as any };
}

function post(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

try {
  await runStartupMigrations();
  await pool.query(
    `INSERT INTO compost_users (id,email,name,role,role_approved_at) VALUES ($1,$2,$3,'facilitator',NOW())`,
    [userId, `${suffix}@event-ready-test.test`, userId],
  );
  await pool.query(`INSERT INTO compost_user_sessions(token,user_id) VALUES($1,$2)`, [userToken, userId]);

  const created = await request("/facilitator/events", post({
    userToken, name: "Ready Status Check", tableCount: 1, tableCapacities: [2],
  }));
  assert.equal(created.status, 201);
  eventId = created.json.eventId as string;
  gameId = created.json.tables[0].gameId as string;
  const code = (created.json.code as string).toLowerCase();

  const joined = await request(`/events/${code}/join`, post({ name: "Ready Guest" }));
  assert.equal(joined.status, 201);
  const seatToken = joined.json.token as string;
  const readinessPath = `/events/${code}/ready?token=${encodeURIComponent(seatToken)}`;

  assert.equal((await request(`/events/${code}/ready`)).status, 403,
    "readiness is scoped to a valid event guest token");
  assert.deepEqual((await request(readinessPath)).json, { ready: false },
    "a new seat reads its persisted not-ready value");

  assert.equal((await request(`/events/${code}/ready`, post({ token: seatToken, ready: true }))).status, 200);
  assert.deepEqual((await request(readinessPath)).json, { ready: true },
    "the read endpoint reflects the existing ready mutation");

  const resumed = await request(`/events/${code}/join`, post({ name: "Ready Guest", existingToken: seatToken }));
  assert.equal(resumed.status, 200, "a returning guest resumes the saved seat");
  assert.deepEqual((await request(readinessPath)).json, { ready: true },
    "readiness remains persisted across reconnect");

  assert.equal((await request(`/events/${code}/ready`, post({ token: seatToken, ready: false }))).status, 200);
  assert.deepEqual((await request(readinessPath)).json, { ready: false },
    "a guest can undo readiness and hydrate the saved not-ready value");
} finally {
  if (eventId) await pool.query(`DELETE FROM compost_events WHERE id=$1`, [eventId]).catch(() => undefined);
  if (gameId) {
    await pool.query(`DELETE FROM compost_game_tokens WHERE game_id=$1`, [gameId]).catch(() => undefined);
    await pool.query(`DELETE FROM compost_games WHERE game_id=$1`, [gameId]).catch(() => undefined);
  }
  await pool.query(`DELETE FROM compost_user_sessions WHERE user_id=$1`, [userId]).catch(() => undefined);
  await pool.query(`DELETE FROM compost_users WHERE id=$1`, [userId]).catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
}