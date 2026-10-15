import { pgTable, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";

// Intentionally no game/user FK: aggregate history survives game/account deletion.
export const compostGameAnalytics = pgTable("compost_game_analytics", {
  gameId: text("game_id").primaryKey(),
  mode: text("mode").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  started: boolean("started").notNull().default(false),
  startedAt: timestamp("started_at", { withTimezone: true }),
  firstTurnAt: timestamp("first_turn_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endReason: text("end_reason"),
  playerCount: integer("player_count"),
  humanCount: integer("human_count"),
  botCount: integer("bot_count"),
  legacy: boolean("legacy").notNull().default(false),
  isTest: boolean("is_test").notNull().default(false),
});
