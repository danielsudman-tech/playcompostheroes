import { viewerFingerprint } from "@/lib/gameCache";

export interface EventSeatReference {
  gameId: string;
  playerId?: string;
}

export interface EventSeatReadiness {
  ready: boolean;
}

export function eventReadinessQueryKey(
  code: string,
  seat: EventSeatReference,
  token?: string | null,
) {
  return [
    "event-seat-readiness",
    code.toLowerCase(),
    seat.gameId,
    seat.playerId ?? "unknown-seat",
    "viewer",
    viewerFingerprint(token),
  ] as const;
}

export function isEventSeatReadyFromServer(status: EventSeatReadiness | null | undefined): boolean {
  return status?.ready === true;
}

export function eventTablePath(gameId: string): string {
  return `/game/${encodeURIComponent(gameId)}/table`;
}