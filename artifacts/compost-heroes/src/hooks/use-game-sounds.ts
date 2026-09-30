/**
 * useGameSounds — diffs consecutive game states and fires the right sound.
 *
 * Five core events per the simplified spec:
 *   1. hero_place     — any hero placed in pile (new layer or stacking)
 *   2. draw_discard   — draw a card, or discard to hand limit (same sound)
 *   3. action_card    — any action card played (immediate or ongoing, placed or resolved)
 *   4. layer_complete — first hero on a previously-empty layer (full volume, all players)
 *   5. win            — player completes all 5 layers (full volume, all players)
 *
 * Attach once per page. Returns { muted, toggleMute } for the UI mute button.
 */
import { useEffect, useRef } from "react";
import { useSoundEngine } from "./use-sound-engine";
import type { GameState } from "@workspace/api-client-react";

// Shape we snapshot from each state update for diffing
interface Snapshot {
  phase: string;
  currentPlayerIndex: number;
  winner: string | null;
  players: {
    id: string;
    handLen: number;
    // map from pile-function → count, to detect first-card-in-layer
    pileByFn: Record<string, number>;
    pileLen: number;
  }[];
  discardLen: number;
}

function snapshot(gs: GameState): Snapshot {
  return {
    phase: gs.phase,
    currentPlayerIndex: gs.currentPlayerIndex,
    winner: gs.winner ?? null,
    players: gs.players.map((p) => {
      const pileByFn: Record<string, number> = {};
      for (const card of p.compostPile ?? []) {
        if (card.function) pileByFn[card.function] = (pileByFn[card.function] ?? 0) + 1;
      }
      return {
        id: p.id,
        handLen: p.hand?.length ?? 0,
        pileByFn,
        pileLen: p.compostPile?.length ?? 0,
      };
    }),
    discardLen: gs.discardPile?.length ?? 0,
  };
}

export function useGameSounds(
  gameState: GameState | undefined,
  localPlayerId: string | undefined
) {
  const { play, muted, toggleMute } = useSoundEngine();
  const prevRef = useRef<Snapshot | null>(null);

  useEffect(() => {
    if (!gameState || !localPlayerId) return;

    const curr = snapshot(gameState);
    const prev = prevRef.current;
    prevRef.current = curr;

    // Skip the very first snapshot — no diff to compare
    if (!prev) return;

    const currentPlayer = gameState.players[curr.currentPlayerIndex];
    const isActivePlayer = currentPlayer?.id === localPlayerId;

    // ── 1. Win ────────────────────────────────────────────────────────────
    if (curr.phase === "game_over" && prev.phase !== "game_over") {
      play("win", true); // full volume for everyone
      return;
    }

    // ── 2. Per-player pile and hand changes ───────────────────────────────
    for (const currP of curr.players) {
      const prevP = prev.players.find((p) => p.id === currP.id);
      if (!prevP) continue;

      const isActor = currentPlayer?.id === currP.id;

      // 2a. Compost pile grew → hero placed
      if (currP.pileLen > prevP.pileLen) {
        // Detect if any function's first card was just placed (layer_complete)
        let layerCompleted = false;
        for (const fn of Object.keys(currP.pileByFn)) {
          const currCount = currP.pileByFn[fn] ?? 0;
          const prevCount = prevP.pileByFn[fn] ?? 0;
          if (currCount > prevCount && prevCount === 0) {
            layerCompleted = true;
            break;
          }
        }

        play("hero_place", isActor);

        if (layerCompleted) {
          // Small delay so the chime sits on top of the thud
          setTimeout(() => play("layer_complete", true), 220);
        }
      }

      // 2b. Self drew a card (hand grew)
      if (currP.id === localPlayerId && currP.handLen > prevP.handLen && curr.phase !== "game_over") {
        play("draw_discard", true);
      }

      // 2c. Self discarded to hand limit (hand shrank during end_turn / effect_resolution)
      if (
        currP.id === localPlayerId &&
        currP.handLen < prevP.handLen &&
        (curr.phase === "end_turn" || curr.phase === "effect_resolution")
      ) {
        play("draw_discard", true);
      }
    }

    // ── 3. Action card played (discard pile grew with an action on top) ───
    if (curr.discardLen > prev.discardLen) {
      const topCard = gameState.discardPile[gameState.discardPile.length - 1];
      if (topCard?.type === "action") {
        play("action_card", isActivePlayer);
      }
    }

    // Note: ongoing card placement is already covered by the discard-grew
    // branch above (the card lands in the discard pile when played). Clearing
    // of an ongoing on turn-end is intentionally silent per the simplified spec.

  }, [gameState, localPlayerId, play]); // eslint-disable-line react-hooks/exhaustive-deps

  return { muted, toggleMute };
}
