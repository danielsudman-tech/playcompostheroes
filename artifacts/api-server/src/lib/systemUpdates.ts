import type { GameState } from "./gameEngine.js";
export function addSystemUpdate(state: GameState, text: string, now = Date.now()): GameState {
  const sequence = (state.systemUpdateSequence ?? 0) + 1;
  return { ...state, systemUpdateSequence: sequence,
    systemUpdates: [...(state.systemUpdates ?? []).slice(-39),
      { id: `${state.gameId}-system-${sequence}`, text, ts: now }] };
}