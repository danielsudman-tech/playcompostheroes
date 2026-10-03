/** Seat-cover helpers. isBot stays true while covered; the name is never rewritten. */
export interface CoverFields { botCovering?: boolean; consecutiveMissedTurns?: number }
export const isCovered = (p: CoverFields | null | undefined) => p?.botCovering === true;
export const coverLabel = (name: string) => `Bot covering ${name}`;
export const missedTurnsCopy = (name: string, missed: number) =>
  `${name} missed ${missed === 2 ? "two" : missed} turns.`;

/** Rising/falling edges between two snapshots of player cover state. */
export function coverTransitions(
  prev: Record<string, boolean>,
  players: { id: string; name: string; botCovering?: boolean; consecutiveMissedTurns?: number }[],
) {
  const out: { id: string; name: string; kind: "covering" | "back"; missed: number }[] = [];
  for (const p of players) {
    const was = prev[p.id];
    const now = p.botCovering === true;
    if (was === undefined) continue;
    if (!was && now) out.push({ id: p.id, name: p.name, kind: "covering", missed: p.consecutiveMissedTurns ?? 2 });
    if (was && !now) out.push({ id: p.id, name: p.name, kind: "back", missed: 0 });
  }
  return out;
}
