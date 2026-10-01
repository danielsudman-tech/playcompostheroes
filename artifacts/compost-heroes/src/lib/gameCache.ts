import { getGetGameQueryKey } from "@workspace/api-client-react";

export const VIEWER_ID_LIMIT = 512;
const viewerIds = new Map<string, number>();
let nextViewerId = 1;

/**
 * Collision-free opaque per-credential id: a module-level token -> monotonic
 * counter map. Ids are never reused; the oldest aliases are pruned past the
 * bound (a pruned token simply gets a fresh id, i.e. a cache miss, never a
 * shared entry). The raw token is never placed in a query key.
 */
export function viewerFingerprint(token: string | null | undefined): string {
  if (!token) return "anon";
  let id = viewerIds.get(token);
  if (id === undefined) {
    id = nextViewerId++;
    viewerIds.set(token, id);
    if (viewerIds.size > VIEWER_ID_LIMIT) {
      const oldest = viewerIds.keys().next().value;
      if (oldest !== undefined) viewerIds.delete(oldest);
    }
  } else {
    // refresh recency so active credentials are not pruned
    viewerIds.delete(token);
    viewerIds.set(token, id);
  }
  return `viewer-${id}`;
}

/**
 * Game state cache key scoped by game AND viewer credential. It extends the
 * generated key, so prefix invalidation of getGetGameQueryKey(gameId) still
 * reaches every viewer's entry.
 */
export function gameStateKey(gameId: string, token?: string | null) {
  return [...getGetGameQueryKey(gameId), "viewer", viewerFingerprint(token)] as const;
}

/** Monotonic guard: only the latest viewer generation may ingest results. */
export function createViewerGuard() {
  let generation = 0;
  let viewer = "";
  return {
    begin(gameId: string, token?: string | null) {
      viewer = `${gameId}::${viewerFingerprint(token)}`;
      return ++generation;
    },
    isCurrent(gen: number, gameId: string, token?: string | null) {
      return gen === generation && viewer === `${gameId}::${viewerFingerprint(token)}`;
    },
  };
}

export interface ClaimIdentity {
  gameId: string | null;
  viewer: string | null;
  generation: number;
}

/**
 * Claim identity is game + stored seat credential. null -> token is the claim
 * landing (same generation); token -> different token is a seat switch and
 * starts a new generation so the old in-flight claim is ignored.
 */
export function nextClaimIdentity(current: ClaimIdentity, gameId: string | null, viewer: string | null): ClaimIdentity {
  // token -> other token (switch) and token -> none (removal) both retire the old claim
  const switched = !!current.viewer && current.viewer !== viewer;
  if (current.gameId !== gameId || switched) return { gameId, viewer, generation: current.generation + 1 };
  if (current.viewer !== viewer) return { ...current, viewer };
  return current;
}

/**
 * A disabled claim must not stay loading: if the request that is loading belongs
 * to an older generation than the active identity, retire it and clear loading.
 * (A manual claim of the current generation is left alone.)
 */
export function shouldRetireClaim(loadingGeneration: number | null, identity: ClaimIdentity, enabled: boolean): boolean {
  return (!enabled || !identity.gameId) && loadingGeneration !== null && loadingGeneration !== identity.generation;
}

/** A generation that has not been attempted yet must claim (also after a switch). */
export function shouldAttemptClaim(attemptedGeneration: number | null, identity: ClaimIdentity, enabled: boolean): boolean {
  return !!identity.gameId && enabled && attemptedGeneration !== identity.generation;
}
