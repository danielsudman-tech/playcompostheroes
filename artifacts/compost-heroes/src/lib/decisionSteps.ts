// Step metadata for multi-step decision chains, used by the guided
// facilitated-mode decision panel ("Step X of Y").
// Keys are the engine's PendingDecision.type values.

export interface DecisionStepInfo {
  step: number;
  total: number;
  label: string;
}

export const DECISION_STEPS: Record<string, DecisionStepInfo> = {
  // Breezy Bandit — 3-step swap
  choose_swap_opponent_breezy: { step: 1, total: 3, label: "Pick a player to swap with" },
  choose_swap_their_card_breezy: { step: 2, total: 3, label: "Pick the card to take from their pile" },
  choose_swap_my_card_breezy: { step: 3, total: 3, label: "Pick the card to give from your pile" },

  // Under-Web — 2-step swap
  choose_under_web_hand_card: { step: 1, total: 2, label: "Pick a card from your hand to give away" },
  choose_under_web_discard_card: { step: 2, total: 2, label: "Pick a card to take from the discard pile" },

  // Anaerobic Pocket — 2-step
  choose_card_from_compost: { step: 1, total: 2, label: "Pick an Airflow card to discard from your pile" },
  choose_target_player: { step: 2, total: 2, label: "Pick an opponent to skip their next turn" },

  // Steal chains (Brown Rogue / Carbon Sink)
  choose_opponent_for_steal: { step: 1, total: 2, label: "Pick an opponent" },
  choose_steal_card: { step: 2, total: 2, label: "Pick the card to take" },

  // Rot & Regrow — 2-step
  choose_rot_regrow_discard: { step: 1, total: 2, label: "Pick 3 cards to discard" },
  choose_rot_regrow_take: { step: 2, total: 2, label: "Pick 1 card from the discard pile" },

  // Rot Roulette — 2-step
  choose_rot_roulette_keep: { step: 1, total: 2, label: "Pick 2 cards to keep" },

  // Single-step decisions
  choose_card_from_hand: { step: 1, total: 1, label: "Pick a card from your hand" },
  choose_card_from_discard: { step: 1, total: 1, label: "Pick a card from the discard pile" },
  choose_hero_from_discard: { step: 1, total: 1, label: "Pick a Hero from the discard pile" },
  choose_rainstorm_play: { step: 1, total: 1, label: "Choose which drawn cards to play" },
  choose_discard_for_spread: { step: 1, total: 1, label: "Pick cards to give away" },
  choose_nitrogen_boost_discard: { step: 1, total: 1, label: "Pick a Nitrogen card to discard" },
  choose_worm_party_card: { step: 1, total: 1, label: "Pick a card to pass left" },
  choose_soggy_pile_discard: { step: 1, total: 1, label: "Pick which pile card to discard" },
  choose_card_to_swap_compost: { step: 1, total: 1, label: "Pick a pile card to swap" },
  choose_card_from_opponent_compost: { step: 1, total: 1, label: "Pick a card from their pile" },
  choose_compost_to_swap_breezy: { step: 1, total: 1, label: "Pick your pile card to swap away" },
  choose_discard_to_limit: { step: 1, total: 1, label: "Discard down to your hand limit" },
  choose_function: { step: 1, total: 1, label: "Choose which slot this hero fills" },
  choose_move_function: { step: 1, total: 1, label: "Choose the slot to move this card to" },
};

// Rot Roulette's follow-up "play one of the kept cards" reuses choose_card_from_hand;
// the meta flag distinguishes it — handled where the map is consumed.
export function getDecisionStepInfo(type: string, meta?: Record<string, unknown>): DecisionStepInfo | null {
  if (type === "choose_card_from_hand" && meta && (meta as any).rotRoulettePlay) {
    return { step: 2, total: 2, label: "Play 1 of your kept cards now" };
  }
  return DECISION_STEPS[type] ?? null;
}
