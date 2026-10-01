import { pool } from "@workspace/db";
import type { PgQueryable } from "./gameStore.js";

const enabledByEventId = new Map<string, boolean>();

export async function hydrateEventTriviaSettings(client: PgQueryable = pool): Promise<void> {
  const result = await client.query(`SELECT id, trivia_enabled FROM compost_events`);
  enabledByEventId.clear();
  for (const row of result.rows) {
    enabledByEventId.set(String(row.id), row.trivia_enabled !== false);
  }
}

export function setEventTriviaEnabled(eventId: string, enabled: boolean): void {
  enabledByEventId.set(eventId, enabled);
}

export function getEventTriviaEnabled(eventId: string | null | undefined): boolean {
  return !eventId || enabledByEventId.get(eventId) !== false;
}