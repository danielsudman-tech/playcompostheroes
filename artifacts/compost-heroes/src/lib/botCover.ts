/** Seat-cover helpers. isBot stays true while covered; the name is never rewritten. */
export interface CoverFields { botCovering?: boolean; consecutiveMissedTurns?: number; botCoverReason?: "timer" | "host" }
export const isCovered = (p: CoverFields | null | undefined) => p?.botCovering === true;
export const coverLabel = (name: string) => `Bot covering ${name}`;
export const missedTurnsCopy = (name: string, missed: number) =>
  `${name} missed ${missed === 2 ? "two" : missed} turns.`;

export type CoverPlayer = { id: string; name: string; isBot?: boolean } & CoverFields;

/** Edges between snapshots. "back" only when the seat is a human again (not a permanent removal). */
export function coverTransitions(prev: Record<string, boolean>, players: CoverPlayer[]) {
  const out: { id: string; name: string; kind: "covering" | "back"; missed: number; reason: "timer" | "host" }[] = [];
  for (const p of players) {
    const was = prev[p.id];
    const now = p.botCovering === true;
    if (was === undefined) continue;
    if (!was && now) out.push({ id: p.id, name: p.name, kind: "covering", missed: p.consecutiveMissedTurns ?? 2, reason: p.botCoverReason ?? "timer" });
    if (was && !now && !p.isBot) out.push({ id: p.id, name: p.name, kind: "back", missed: 0, reason: "timer" });
  }
  return out;
}
