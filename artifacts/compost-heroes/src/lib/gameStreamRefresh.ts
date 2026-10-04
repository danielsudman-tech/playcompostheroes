/** Event-driven recovery only: coalesce refresh events until the viewer GET finishes. */
export function createStreamRefresh(
  refetch: () => Promise<unknown>,
  isActive: () => boolean,
): () => void {
  let pending = false;
  return () => {
    if (!isActive() || pending) return;
    pending = true;
    void Promise.resolve()
      .then(() => isActive() ? refetch() : undefined)
      .catch(() => { /* Existing query error/reconnect handling owns failures. */ })
      .finally(() => { pending = false; });
  };
}