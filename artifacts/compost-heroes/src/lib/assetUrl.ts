/**
 * Returns the URL for a card/game asset by key.
 * Routes through the API server (/api/assets/) so that images uploaded at
 * runtime are always accessible — in both dev and production.
 */
export function assetUrl(key: string): string {
  return `/api/assets/${key}`;
}
