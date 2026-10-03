/** Canonical, already-sanitized server log lines that belong in the single Game Updates history. */
const CANONICAL = [
  /^Time ran out\. .+ was finished automatically\.$/,
  /^.+ was removed from the game and permanently replaced by a bot\.$/,
];

export interface LogNotice { id: string; text: string }

/** Stable id = text + nth occurrence, so repeated snapshots/reconnects never double-log. */
export function canonicalLogNotices(log: readonly string[] | null | undefined): LogNotice[] {
  const seen = new Map<string, number>();
  const out: LogNotice[] = [];
  for (const raw of log ?? []) {
    const text = String(raw).trim();
    if (!CANONICAL.some((re) => re.test(text))) continue;
    const n = seen.get(text) ?? 0;
    seen.set(text, n + 1);
    out.push({ id: `log:${text}:${n}`, text });
  }
  return out;
}

export interface SystemUpdate { id: string; text: string; ts: number }

/**
 * Durable server system updates use their own unique ids and ts. The canonical-log
 * fallback applies ONLY to old servers (systemUpdates undefined), never both.
 */
export function systemNotices(
  systemUpdates: readonly SystemUpdate[] | null | undefined,
  log: readonly string[] | null | undefined,
): { id: string; text: string; at?: number }[] {
  if (systemUpdates !== undefined && systemUpdates !== null) {
    return [...systemUpdates].sort((a, b) => a.ts - b.ts).map((u) => ({ id: `system:${u.id}`, text: u.text, at: u.ts }));
  }
  return canonicalLogNotices(log);
}
