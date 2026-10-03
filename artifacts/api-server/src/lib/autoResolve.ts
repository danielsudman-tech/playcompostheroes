import type { GameState } from "./gameEngine.js";

/** Server-only choices; never copy hidden options into a public announcement. */
export function buildAutoResolveData(decision: NonNullable<GameState["pendingDecision"]>): Record<string, unknown> {
  const opts = (decision.options ?? []) as any[];
  const meta = decision.meta ?? {};
  switch (decision.type) {
    case "choose_rot_roulette_keep":
      return { keepCardIds: opts.slice(0, Number(meta.keepCount ?? 2)).map(o => o.cardId) };
    case "choose_discard_for_spread":
    case "choose_discard_to_limit":
      return { cardIds: opts.slice(0, Number(meta.count ?? 1)).map(o => o.cardId) };
    case "choose_rot_regrow_discard":
      return { cardIds: opts.slice(0, 3).map(o => o.cardId) };
    case "choose_rainstorm_play":
      return { cardIds: [] };
    case "choose_target_player":
    case "choose_opponent_for_steal":
    case "choose_swap_opponent_breezy":
      return { targetPlayerId: opts[0]?.targetPlayerId ?? opts[0]?.playerId, targetCardId: opts[0]?.targetCardId };
    case "choose_function":
    case "choose_move_function":
      return { function: opts[0]?.function };
    default:
      if (meta.optional === true || opts.some(o => o?.skip)) return { skip: true };
      return opts[0] && typeof opts[0] === "object" ? { ...opts[0] } : { skip: true };
  }
}