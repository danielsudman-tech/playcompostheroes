import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { getUserByToken } from "../lib/userStore.js";

const suffix = randomUUID();
const userId = `auth-expiry-${suffix}`;
const freshToken = `auth-expiry-fresh-${suffix}`;
const expiredToken = `auth-expiry-old-${suffix}`;

try {
  await pool.query(
    `INSERT INTO compost_users (id, email, name) VALUES ($1, $2, $3)`,
    [userId, `${suffix}@auth-expiry.test`, "Session expiry test"],
  );
  await pool.query(
    `INSERT INTO compost_user_sessions (token, user_id, created_at)
     VALUES ($1, $3, NOW()), ($2, $3, NOW() - INTERVAL '31 days')`,
    [freshToken, expiredToken, userId],
  );

  assert.equal((await getUserByToken(freshToken))?.id, userId);
  assert.equal(await getUserByToken(expiredToken), null, "expired legacy session must be rejected");
  console.log("auth-session-expiry.test.ts: all assertions passed ✔");
} finally {
  await pool.query(`DELETE FROM compost_users WHERE id = $1`, [userId]);
}