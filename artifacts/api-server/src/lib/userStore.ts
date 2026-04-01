import { pool } from "@workspace/db";
import bcrypt from "bcryptjs";

export interface CompostUser {
  id: string;
  email: string;
  name: string;
  organization?: string | null;
  role?: string | null;
  createdAt: string;
}

function generateToken(): string {
  return (
    Math.random().toString(36).substring(2) +
    Math.random().toString(36).substring(2) +
    Math.random().toString(36).substring(2)
  );
}

async function createSession(userId: string): Promise<string> {
  const token = generateToken();
  await pool.query(
    `INSERT INTO compost_user_sessions (token, user_id) VALUES ($1, $2)`,
    [token, userId]
  );
  return token;
}

export async function registerUser(
  email: string,
  name: string,
  password: string,
  organization?: string,
  role?: string
): Promise<{ token: string; user: CompostUser }> {
  const normalizedEmail = email.toLowerCase().trim();

  // Check if email already exists
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM compost_users WHERE email = $1`,
    [normalizedEmail]
  );
  if (existing.rows.length > 0) {
    throw Object.assign(new Error("That email is already registered. Please sign in instead."), { code: "EMAIL_EXISTS" });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await pool.query<{
    id: string;
    email: string;
    name: string;
    organization: string | null;
    role: string | null;
    created_at: string;
  }>(
    `INSERT INTO compost_users (id, email, name, organization, role, password_hash)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5)
     RETURNING id, email, name, organization, role, created_at`,
    [
      normalizedEmail,
      name.trim(),
      organization?.trim() || null,
      role?.trim() || null,
      passwordHash,
    ]
  );

  const row = result.rows[0];
  const user: CompostUser = {
    id: row.id,
    email: row.email,
    name: row.name,
    organization: row.organization,
    role: row.role,
    createdAt: row.created_at,
  };

  const token = await createSession(user.id);
  return { token, user };
}

export async function loginUser(
  email: string,
  password: string
): Promise<{ token: string; user: CompostUser }> {
  const normalizedEmail = email.toLowerCase().trim();

  const result = await pool.query<{
    id: string;
    email: string;
    name: string;
    organization: string | null;
    role: string | null;
    created_at: string;
    password_hash: string | null;
  }>(
    `SELECT id, email, name, organization, role, created_at, password_hash
     FROM compost_users WHERE email = $1`,
    [normalizedEmail]
  );

  if (result.rows.length === 0) {
    throw Object.assign(new Error("No account found with that email. Please register first."), { code: "USER_NOT_FOUND" });
  }

  const row = result.rows[0];

  if (!row.password_hash) {
    throw Object.assign(new Error("This account was created before passwords were added. Please register again to set a password."), { code: "NO_PASSWORD" });
  }

  const match = await bcrypt.compare(password, row.password_hash);
  if (!match) {
    throw Object.assign(new Error("Incorrect password. Please try again."), { code: "WRONG_PASSWORD" });
  }

  const user: CompostUser = {
    id: row.id,
    email: row.email,
    name: row.name,
    organization: row.organization,
    role: row.role,
    createdAt: row.created_at,
  };

  const token = await createSession(user.id);
  return { token, user };
}

export async function resetUserPassword(userId: string, newPassword: string): Promise<void> {
  const passwordHash = await bcrypt.hash(newPassword, 12);
  const result = await pool.query(
    `UPDATE compost_users SET password_hash = $1 WHERE id = $2`,
    [passwordHash, userId]
  );
  if (result.rowCount === 0) {
    throw Object.assign(new Error("User not found"), { code: "USER_NOT_FOUND" });
  }
  // Invalidate all existing sessions so the user must log in with the new password
  await pool.query(`DELETE FROM compost_user_sessions WHERE user_id = $1`, [userId]);
}

export async function getUserByToken(token: string): Promise<CompostUser | null> {
  const result = await pool.query<{
    id: string;
    email: string;
    name: string;
    organization: string | null;
    role: string | null;
    created_at: string;
  }>(
    `SELECT u.id, u.email, u.name, u.organization, u.role, u.created_at
     FROM compost_users u
     JOIN compost_user_sessions s ON s.user_id = u.id
     WHERE s.token = $1`,
    [token]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    organization: row.organization,
    role: row.role,
    createdAt: row.created_at,
  };
}
