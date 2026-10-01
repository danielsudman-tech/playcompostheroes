export type HotPileCard = {
  id: string;
  baseId?: string;
  function: string;
  chosenFunction?: string;
  alternateFunctions?: string[];
};

/** Use instance-ID suffixes for legacy cards that lack an explicit baseId. */
export function getCardBaseId(card: Pick<HotPileCard, "id" | "baseId">): string {
  return card.baseId ?? card.id.split("__", 1)[0] ?? card.id;
}

/** Hot Pile counts a qualifying card once, whichever slot it currently uses. */
export function countsForHotPile(card: HotPileCard): boolean {
  return (card.chosenFunction ?? card.function) === "Decomposer" ||
    card.function === "Decomposer" ||
    card.alternateFunctions?.includes("Decomposer") === true;
}

export function isHotPileCard(card: Pick<HotPileCard, "id" | "baseId">): boolean {
  return getCardBaseId(card) === "hot_pile_bonus";
}