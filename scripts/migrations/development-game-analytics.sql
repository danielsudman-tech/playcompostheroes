-- Apply only to development when working locally. Production schema belongs to
-- the managed Publish flow. Do not run a broad schema push on legacy raw tables.
CREATE TABLE IF NOT EXISTS compost_game_analytics (
  game_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ,
  first_turn_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  player_count INTEGER,
  human_count INTEGER,
  bot_count INTEGER,
  legacy BOOLEAN NOT NULL DEFAULT FALSE,
  is_test BOOLEAN NOT NULL DEFAULT FALSE
);
