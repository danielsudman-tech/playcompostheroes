import { pool } from "@workspace/db";
import type { PgQueryable } from "./gameStore.js";

const enabledByEventId = new Map<string, boolean>();
type EventTriviaRead = { eventId: string; generation: number };
type EventTriviaGeneration = { generation: number; readers: number };
const generations = new Map<string, EventTriviaGeneration>();

export function beginEventTriviaRead(eventId: string): EventTriviaRead {
  let current = generations.get(eventId);
  if (!current) {
    current = { generation: 0, readers: 0 };
    generations.set(eventId, current);
  }
  current.readers++;
  return { eventId, generation: current.generation };
}

export function finishEventTriviaRead(read: EventTriviaRead): void {
  const current = generations.get(read.eventId);
  if (!current) return;
  current.readers--;
  if (current.readers <= 0) generations.delete(read.eventId);
}

export function setEventTriviaEnabledIfCurrent(
  read: EventTriviaRead,
  enabled: boolean,
): boolean {
  const current = generations.get(read.eventId);
  if (!current || current.generation !== read.generation) return false;
  enabledByEventId.set(read.eventId, enabled);
  return true;
}

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

export function forgetEventTriviaEnabled(eventId: string): void {
  enabledByEventId.delete(eventId);
  const current = generations.get(eventId);
  if (current) current.generation++;
}

export function getEventTriviaEnabled(eventId: string | null | undefined): boolean {
  return !eventId || enabledByEventId.get(eventId) !== false;
}