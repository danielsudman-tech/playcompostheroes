export interface TurnButtonInput {
  isMyTurn: boolean;
  phase: string;
  pending: boolean;
}

export interface TurnButtonView {
  kind: "draw" | "end" | null;
  label: string | null;
  disabled: boolean;
}

/** Main turn button shown on narrow screens; mirrors the desktop controls' guards. */
export function turnButtonView({ isMyTurn, phase, pending }: TurnButtonInput): TurnButtonView {
  if (!isMyTurn || phase === "game_over") return { kind: null, label: null, disabled: true };
  if (phase === "draw") return { kind: "draw", label: "Draw a Card", disabled: pending };
  return { kind: "end", label: "End Turn", disabled: pending };
}

/** Accessible name for a face-up hand card. */
export function handCardLabel(card: { name: string; type: string }): string {
  return `${card.name}, ${card.type}`;
}

/** Accessible name for hidden cards; never reveals identity. */
export function hiddenHandLabel(count: number): string {
  return `${count} hidden card${count === 1 ? "" : "s"}`;
}

/**
 * Runs a draw only when allowed; closes the drawer after a successful draw.
 * Returns false when guarded out.
 */
export function drawAndCloseDrawer(
  guard: { isMyTurn: boolean; hasPlayer: boolean; pending: boolean },
  mutate: (opts: { onSuccess: () => void }) => void,
  closeDrawer: () => void,
): boolean {
  if (!guard.isMyTurn || !guard.hasPlayer || guard.pending) return false;
  mutate({ onSuccess: closeDrawer });
  return true;
}
