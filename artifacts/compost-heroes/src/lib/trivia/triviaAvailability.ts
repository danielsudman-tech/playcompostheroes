import type { TriviaAvailability, TriviaMode } from "./triviaTypes";

/**
 * Be opt-in only when a saved Facilitated Event explicitly says false.
 * This remains safe with older Event API responses that lack the new field.
 */
export function isFacilitatedEventTriviaEnabled(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return true;
  return (event as { triviaEnabled?: unknown }).triviaEnabled !== false;
}

/** Prefer the snapshot flag when present; older/direct table responses can use Event metadata. */
export function isFacilitatedGameTriviaEnabled(gameState: unknown, event: unknown): boolean {
  if (typeof gameState === "object" && gameState !== null) {
    const triviaEnabled = (gameState as { triviaEnabled?: unknown }).triviaEnabled;
    if (typeof triviaEnabled === "boolean") return triviaEnabled;
  }
  return isFacilitatedEventTriviaEnabled(event);
}

/** Required choices always take priority over this optional extra. */
export function canOpenTrivia(
  availability: TriviaAvailability,
  mode: TriviaMode,
): boolean {
  if (!availability.enabled || availability.requiredDecision) return false;
  return mode === "handoff" ? availability.handoffActive : availability.waiting;
}