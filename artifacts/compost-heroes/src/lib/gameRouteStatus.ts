export interface GameMetadataResponse {
  status: number;
  ok: boolean;
  mode?: string;
}

export interface GameRouteGate {
  required: boolean;
  removed: boolean;
}

/** A missing public metadata result is terminal; other failures keep the auth gate closed. */
export function gameRouteGateForResponse(response: GameMetadataResponse | null): GameRouteGate {
  if (!response) return { required: true, removed: false };
  if (response.status === 404) return { required: false, removed: true };
  if (!response.ok) return { required: true, removed: false };
  return { required: (response.mode ?? "online") === "online", removed: false };
}

/** Query errors are authoritative even when React Query retains stale game data. */
export function isMissingGameError(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    (error as { status?: unknown }).status === 404;
}