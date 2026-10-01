import type { EventDetail } from "@workspace/api-client-react";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

const eventStatuses = new Set(["upcoming", "active", "ending", "completed"]);
const assignmentModes = new Set(["choose", "auto"]);

export function eventSnapshotGenerationKey(scope: string, eventId: string): string {
  return JSON.stringify([scope, eventId]);
}

export function isCurrentEventSnapshot(requestGeneration: number, currentGeneration: number): boolean {
  return requestGeneration === currentGeneration;
}

export function mergeEventStreamDetail(
  eventId: string,
  payload: unknown,
  previous: EventDetail | undefined,
  requestGeneration: number,
  currentGeneration: number,
): EventDetail | null {
  if (!isCurrentEventSnapshot(requestGeneration, currentGeneration) ||
      !payload || typeof payload !== "object") return null;

  const detail = payload as Partial<EventDetail>;
  if (detail.eventId !== eventId || typeof detail.code !== "string" ||
      typeof detail.name !== "string" || !eventStatuses.has(detail.status ?? "") ||
      !assignmentModes.has(detail.assignmentMode ?? "") ||
      typeof detail.idleSeconds !== "number" || typeof detail.tableCount !== "number" ||
      !Array.isArray(detail.tables) || !detail.tables.every((table) =>
        !!table && typeof table.gameId === "string" && Array.isArray(table.players) &&
        Array.isArray(table.questions))) return null;
  if (detail.hostTokens !== undefined &&
      (!detail.hostTokens || typeof detail.hostTokens !== "object" ||
       Object.values(detail.hostTokens).some((token) => typeof token !== "string"))) return null;

  return {
    ...detail as EventDetail,
    ...(detail.hostTokens === undefined && previous?.hostTokens
      ? { hostTokens: previous.hostTokens }
      : {}),
  };
}

export async function applyEventStreamSnapshot<T>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  eventId: string,
  payload: unknown,
  generation: number,
  currentGeneration: () => number,
  toCacheValue: (detail: EventDetail) => T,
): Promise<boolean> {
  await queryClient.cancelQueries({ queryKey, exact: true });
  const current = currentGeneration();
  if (!isCurrentEventSnapshot(generation, current)) return false;

  const previous = queryClient.getQueryData<EventDetail>(queryKey);
  const detail = mergeEventStreamDetail(eventId, payload, previous, generation, current);
  if (!detail) return false;
  queryClient.setQueryData<T>(queryKey, toCacheValue(detail));
  return true;
}