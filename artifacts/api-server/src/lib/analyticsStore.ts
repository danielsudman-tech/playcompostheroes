import { pool } from "@workspace/db";

export type AnalyticsEventType =
  | "register"
  | "login"
  | "game_created"
  | "player_joined"
  | "game_completed"
  | "game_ended_by_host"
  | "facilitator_resolve";

interface LogEventOptions {
  userId?: string;
  gameId?: string;
  intValue?: number;
  metadata?: Record<string, unknown>;
}

export async function logEvent(
  eventType: AnalyticsEventType,
  opts: LogEventOptions = {}
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO compost_analytics_events (event_type, user_id, game_id, int_value, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        eventType,
        opts.userId ?? null,
        opts.gameId ?? null,
        opts.intValue ?? null,
        opts.metadata ? JSON.stringify(opts.metadata) : null,
      ]
    );
  } catch (err) {
    console.error("[analytics]", eventType, err);
  }
}

export async function runStartupMigrations(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS compost_analytics_events (
        id BIGSERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        user_id TEXT,
        game_id TEXT,
        int_value INTEGER,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `ALTER TABLE compost_games ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`
    );
    await pool.query(
      `ALTER TABLE compost_games ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`
    );
    // Legacy role text was self-supplied at registration. Only roles with this
    // admin-controlled marker grant facilitator privileges.
    await pool.query(
      `ALTER TABLE compost_users ADD COLUMN IF NOT EXISTS role_approved_at TIMESTAMPTZ`
    );
    console.log("[analytics] startup migrations done");
  } catch (err) {
    console.error("[analytics] startup migrations failed", err);
    throw err;
  }
}
