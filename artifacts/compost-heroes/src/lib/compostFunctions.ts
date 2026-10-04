import type { Card } from "@workspace/api-client-react";

/**
 * The five compost functions a player must collect. This is the ONE order used by
 * board columns, pile view and the function-slot picker (it is the existing board order).
 */
export const COMPOST_FUNCTION_ORDER = ["Moisture", "Carbon", "Decomposer", "Nitrogen", "Airflow"] as const;
export type CompostFunction = (typeof COMPOST_FUNCTION_ORDER)[number];

const MATCHERS: Record<CompostFunction, (fn: string) => boolean> = {
  Moisture: (fn) => fn.toLowerCase().includes("moisture"),
  Carbon: (fn) => fn.toLowerCase().includes("carbon"),
  Decomposer: (fn) => fn.toLowerCase().includes("decomp") || fn.toLowerCase().includes("fire"),
  Nitrogen: (fn) => fn.toLowerCase().includes("nitrogen"),
  Airflow: (fn) => fn.toLowerCase().includes("air"),
};

export function matchesCompostFunction(fn: CompostFunction, value: string): boolean {
  return MATCHERS[fn](value ?? "");
}

export function toCompostFunction(value: string): CompostFunction | null {
  return COMPOST_FUNCTION_ORDER.find((fn) => MATCHERS[fn](value ?? "")) ?? null;
}

export function compareCompostFunctions(a: string, b: string): number {
  const ia = COMPOST_FUNCTION_ORDER.indexOf(toCompostFunction(a) as CompostFunction);
  const ib = COMPOST_FUNCTION_ORDER.indexOf(toCompostFunction(b) as CompostFunction);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
}

/** Every function a card may fill, in canonical order (not just card.function). */
export function cardFunctions(card: Pick<Card, "function" | "alternateFunctions">): string[] {
  const raw = [card.function, ...(card.alternateFunctions ?? [])];
  const labels = raw.filter(Boolean).map((v) => toCompostFunction(v) ?? v);
  return Array.from(new Set(labels)).sort(compareCompostFunctions);
}

export const HOME_WIN_COPY = "Collect 1 Hero for each of the 5 compost functions to win!";
export const ONGOING_HERO_COPY = "This hero stays in your compost pile. Its effect lasts as long as it stays there.";
export const ONGOING_ACTION_COPY = "This card stays in play for everyone until another Ongoing card replaces it or a card removes it.";
export const ONGOING_BOARD_LABEL = "Ongoing for everyone";

export const QUICK_RULES: { lead: string; text: string }[] = [
  { lead: "Win", text: "collect one Hero for each of the 5 functions." },
  { lead: "Hand", text: "keep 5 cards or fewer. Discard down before you end your turn." },
  { lead: "Turn", text: "draw 1 card. Play up to 1 Hero, then up to 1 Action. End your turn when ready." },
  { lead: "Ongoing Hero", text: "stays in your pile." },
  { lead: "Ongoing Action", text: "shared by everyone until replaced or removed." },
  { lead: "Activate Effect", text: "runs the manual benefit once per turn." },
  { lead: "Move", text: "on a multi-function Hero changes its function slot." },
  { lead: "Turn timer", text: "when on, it makes a choice for you or draws or ends an unattended turn." },
];

/** Plain decision title; never "Action Required". */
export function decisionTitle(type: string, cardName: string | null, stepLabel?: string | null): string {
  const name = cardName || "this card";
  if (type === "choose_function") return `Choose a function slot for ${name}`;
  if (type === "choose_move_function") return `Choose a new function slot for ${name}`;
  const label = stepLabel || "Make your choice";
  return cardName && !label.includes(cardName) ? `${label} for ${cardName}` : label;
}

/** A multi-function Hero is held in decision metadata before it enters the pile. */
export function decisionOriginCardName(
  decision: { cardId: string; meta?: Record<string, unknown> | null },
  visibleCards: Pick<Card, "id" | "name">[],
): string | null {
  const held = decision.meta?.pendingCard;
  if (held && typeof held === "object" && "name" in held && typeof held.name === "string" &&
    (!("id" in held) || held.id === decision.cardId)) return held.name;
  return visibleCards.find(card => card.id === decision.cardId)?.name ?? null;
}

/** Step banner only for real multi-step chains. */
export function showStepBanner(step: { total: number } | null | undefined): boolean {
  return !!step && step.total > 1;
}
