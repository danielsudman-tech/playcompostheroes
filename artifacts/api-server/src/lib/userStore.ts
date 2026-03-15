import { pool } from "@workspace/db";

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

export async function registerOrLoginUser(
  email: string,
  name: string,
  organization?: string,
  role?: string
): Promise<{ token: string; user: CompostUser; isNew: boolean }> {
  const userResult = await pool.query<{
    id: string;
    email: string;
    name: string;
    organization: string | null;
    role: string | null;
    created_at: string;
    is_new: boolean;
  }>(
    `INSERT INTO compost_users (id, email, name, organization, role)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name,
           organization = COALESCE(EXCLUDED.organization, compost_users.organization),
           role = COALESCE(EXCLUDED.role, compost_users.role)
     RETURNING id, email, name, organization, role, created_at,
               (xmax = '0') AS is_new`,
    [
      email.toLowerCase().trim(),
      name.trim(),
      organization?.trim() || null,
      role?.trim() || null,
    ]
  );

  const row = userResult.rows[0];
  const user: CompostUser = {
    id: row.id,
    email: row.email,
    name: row.name,
    organization: row.organization,
    role: row.role,
    createdAt: row.created_at,
  };

  const token = generateToken();
  await pool.query(
    `INSERT INTO compost_user_sessions (token, user_id) VALUES ($1, $2)`,
    [token, user.id]
  );

  return { token, user, isNew: row.is_new };
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
