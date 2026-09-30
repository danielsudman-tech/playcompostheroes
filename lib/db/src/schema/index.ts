import { pgTable, text, timestamp, integer, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const compostUsers = pgTable("compost_users", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  organization: text("organization"),
  role: text("role"),
  roleApprovedAt: timestamp("role_approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const compostUserSessions = pgTable("compost_user_sessions", {
  token: text("token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => compostUsers.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const compostAnalyticsEvents = pgTable("compost_analytics_events", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
  eventType: text("event_type").notNull(),
  userId: text("user_id"),
  gameId: text("game_id"),
  intValue: integer("int_value"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const compostEvents = pgTable("compost_events", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  facilitatorId: text("facilitator_id").notNull().references(() => compostUsers.id),
  name: text("name").notNull(),
  status: text("status").notNull().default("upcoming"),
  assignmentMode: text("assignment_mode").notNull().default("auto"),
  idleSeconds: integer("idle_seconds").notNull().default(120),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastMeaningfulActivityAt: timestamp("last_meaningful_activity_at", { withTimezone: true }).notNull().defaultNow(),
});

export const compostEventTables = pgTable("compost_event_tables", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().references(() => compostEvents.id, { onDelete: "cascade" }),
  gameId: text("game_id").notNull().unique(),
  tableNumber: integer("table_number").notNull(),
  capacity: integer("capacity").notNull(),
}, (table) => ({
  eventTableUnique: uniqueIndex("compost_event_table_number_uq").on(table.eventId, table.tableNumber),
  eventIndex: index("compost_event_tables_event_idx").on(table.eventId),
}));

export const compostEventSeats = pgTable("compost_event_seats", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().references(() => compostEvents.id, { onDelete: "cascade" }),
  gameId: text("game_id").notNull(),
  playerId: text("player_id").notNull(),
  playerIndex: integer("player_index").notNull(),
  ready: boolean("ready").notNull().default(false),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
}, (table) => ({
  seatUnique: uniqueIndex("compost_event_seat_player_uq").on(table.gameId, table.playerId),
}));

export const compostCardSettings = pgTable("compost_card_settings", {
  cardId: text("card_id").primaryKey(),
  imageKey: text("image_key"),
  copies: integer("copies"),
});

export const compostCardAssetUploads = pgTable("compost_card_asset_uploads", {
  stagingKey: text("staging_key").primaryKey(),
  cardId: text("card_id").notNull(),
  finalKey: text("final_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

