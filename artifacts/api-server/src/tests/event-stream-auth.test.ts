import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { pool } from "@workspace/db";
import eventRoutes from "../routes/events.js";
import gameRoutes from "../routes/game.js";

const suffix = randomUUID();
const userId = `event-stream-auth-${suffix}`;
const userToken = `event-stream-auth-session-${suffix}`;
const eventId = randomUUID();
const app = express();
app.use(express.json());
app.use(eventRoutes);
app.use(gameRoutes);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function jsonRequest(path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, init);
  return { response, body: await response.json() as any };
}

try {
  await pool.query(
    `INSERT INTO compost_users (id,email,name,role,role_approved_at)
     VALUES ($1,$2,$3,'facilitator',NOW())`,
    [userId, `${suffix}@event-stream-auth.test`, "Stream auth test"],
  );
  await pool.query(`INSERT INTO compost_user_sessions (token,user_id) VALUES ($1,$2)`, [userToken, userId]);
  await pool.query(
    `INSERT INTO compost_events (id,code,facilitator_id,name)
     VALUES ($1,$2,$3,'Stream auth test')`,
    [eventId, suffix.slice(0, 8).toUpperCase(), userId],
  );

  assert.equal((await jsonRequest(`/facilitator/events?userToken=${userToken}`)).response.status, 401,
    "event list ignores account tokens in query strings");
  assert.equal((await jsonRequest("/facilitator/events", {
    headers: { Authorization: `Bearer ${userToken}` },
  })).response.status, 200, "event list accepts Authorization");
  assert.equal((await jsonRequest(`/facilitator/events/${eventId}?userToken=${userToken}`)).response.status, 401,
    "event detail ignores account tokens in query strings");
  assert.equal((await jsonRequest(`/facilitator/events/${eventId}`, {
    headers: { Authorization: `Bearer ${userToken}` },
  })).response.status, 200, "event detail accepts Authorization");
  assert.equal((await jsonRequest(`/facilitator/rooms?userToken=${userToken}`)).response.status, 401,
    "facilitator rooms ignores account tokens in query strings");
  assert.equal((await jsonRequest("/facilitator/rooms", {
    headers: { Authorization: `Bearer ${userToken}` },
  })).response.status, 200, "facilitator rooms accepts Authorization");
  assert.equal((await jsonRequest(`/facilitator/events/${eventId}/stream?userToken=${userToken}`)).response.status, 401,
    "event stream ignores account tokens in query strings");

  const issued = await jsonRequest(`/facilitator/events/${eventId}/stream-ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userToken }),
  });
  assert.equal(issued.response.status, 200);
  assert.ok(issued.body.ticket && issued.body.ticket !== userToken);
  console.log("event-stream-auth.test.ts: all assertions passed ✔");
} finally {
  await pool.query(`DELETE FROM compost_events WHERE id=$1`, [eventId]).catch(() => undefined);
  await pool.query(`DELETE FROM compost_user_sessions WHERE user_id=$1`, [userId]).catch(() => undefined);
  await pool.query(`DELETE FROM compost_users WHERE id=$1`, [userId]).catch(() => undefined);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await pool.end();
}