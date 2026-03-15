import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const compostUsers = pgTable("compost_users", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  organization: text("organization"),
  role: text("role"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const compostUserSessions = pgTable("compost_user_sessions", {
  token: text("token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => compostUsers.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
