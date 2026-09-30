import type { RequestHandler } from "express";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * A small per-process fixed-window limiter for sensitive auth endpoints.
 * Each configured instance has an independent bucket, keyed by client IP.
 */
export function createAuthRateLimiter(
  limit: number,
  windowMs: number,
  now: () => number = Date.now,
): RequestHandler {
  const entries = new Map<string, RateLimitEntry>();

  return (req, res, next): void => {
    const timestamp = now();
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    let entry = entries.get(key);

    if (!entry || entry.resetAt <= timestamp) {
      entry = { count: 0, resetAt: timestamp + windowMs };
      entries.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > limit) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1000))));
      res.status(429).json({ error: "Too many attempts. Please try again later." });
      return;
    }

    // Keep a long-lived process from retaining old client entries indefinitely.
    if (entries.size > 10_000) {
      for (const [entryKey, value] of entries) {
        if (value.resetAt <= timestamp) entries.delete(entryKey);
      }
    }
    next();
  };
}