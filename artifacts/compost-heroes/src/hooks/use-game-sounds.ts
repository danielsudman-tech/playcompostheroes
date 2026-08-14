/**
 * useGameSounds — diffs consecutive game states and fires the right sound.
 *
 * Attach once per page. Returns { muted, toggleMute } for the UI mute button.
 */
import { useEffect, useRef } from "react";
import { useSoundEngine, layerIndex } from "./use-sound-engine";
import type { GameState } from "@workspace/api-client-react";

// Shape we snapshot from each state update for diffing
interface Snapshot {
  phase: string;
  currentPlayerIndex: number;
  winner: string | null;
  ongoingId: string | null;
  // Per-player: hand size and compost-pile function multiset
  players: {
    id: string;
    handLen: number;
    // map from function → count
    pileByFn: Record<string, number>;
    pileLen: number;
  }[];
  discardLen: number;
  deckLen: number;
}

function snapshot(gs: GameState): Snapshot {
  return {
    phase: gs.phase,
    currentPlayerIndex: gs.currentPlayerIndex,
    winner: gs.winner ?? null,
    ongoingId: gs.ongoingActionCard?.id ?? null,
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
    deckLen: (gs as any).deck?.length ?? 0,
  };
}

export function useGameSounds(
  gameState: GameState | undefined,
  localPlayerId: string | undefined
) {
  const { play, startAmbient, stopAmbient, muted, toggleMute } = useSoundEngine();
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

    // ── 1. Turn passed to me ──────────────────────────────────────────────
    if (
      curr.currentPlayerIndex !== prev.currentPlayerIndex &&
      isActivePlayer &&
      curr.phase === "play"
    ) {
      play("turn_to_me", true);
      return; // dominant event this tick — don't stack other sounds
    }

    // ── 2. Win ────────────────────────────────────────────────────────────
    if (curr.phase === "game_over" && prev.phase !== "game_over") {
      play("win", true); // full volume for everyone
      stopAmbient();
      return;
    }

    // ── 3. Ongoing card placed / cleared ─────────────────────────────────
    if (curr.ongoingId !== prev.ongoingId) {
      if (curr.ongoingId && !prev.ongoingId) {
        play("ongoing_place", isActivePlayer);
        startAmbient();
      } else if (!curr.ongoingId && prev.ongoingId) {
        play("ongoing_clear", isActivePlayer);
        stopAmbient();
      } else {
        // replaced with a different card
        play("ongoing_clear", isActivePlayer);
        setTimeout(() => {
          play("ongoing_place", isActivePlayer);
          startAmbient();
        }, 300);
      }
    }

    // ── 4. Per-player changes ─────────────────────────────────────────────
    for (const currP of curr.players) {
      const prevP = prev.players.find((p) => p.id === currP.id);
      if (!prevP) continue;

      const isSelf = currP.id === localPlayerId;
      // For other players' sounds use isActivePlayer flag based on who is
      // the *current* turn player (who caused the action)
      const isActor = currentPlayer?.id === currP.id;

      // 4a. Hand grew → draw (only meaningful for the active player)
      if (isSelf && currP.handLen > prevP.handLen && curr.phase !== "game_over") {
        play("draw", true); // always self
      }

      // 4b. Compost pile changed — detect hero placement type
      if (currP.pileLen > prevP.pileLen) {
        // Find which function was added (or grew)
        for (const fn of Object.keys(currP.pileByFn)) {
          const currCount = currP.pileByFn[fn] ?? 0;
          const prevCount = prevP.pileByFn[fn] ?? 0;
          if (currCount > prevCount) {
            const isFirst = prevCount === 0;
            if (isFirst) {
              // New layer — play hero_new_layer + layer_complete chime
              play("hero_new_layer", isActor);
              // Small delay so the chime sits on top of the plop
              const idx = layerIndex(fn);
              setTimeout(() => play("layer_complete", true, { layerIdx: idx }), 220);
            } else {
              // Stacking on existing layer
              play("hero_stacking", isActor);
            }
            break; // one function changed per tick
          }
        }
      }

      // 4c. Hand shrank — could be: played a card or discarded to limit
      if (currP.handLen < prevP.handLen && currP.id === localPlayerId) {
        // Discard to limit happens in end_turn phase
        if (curr.phase === "end_turn" || curr.phase === "effect_resolution") {
          play("discard_limit", true);
        }
        // Action card plays are inferred from the discard pile growing
        // (handled below) to avoid double-firing
      }
    }

    // ── 5. Discard pile grew → action card played ─────────────────────────
    if (curr.discardLen > prev.discardLen) {
      const topCard = gameState.discardPile[gameState.discardPile.length - 1];
      if (topCard?.type === "action") {
        // Check if it's a "forced" / self-harm effect via lastEffect
        const lastEffect = (gameState as any).lastEffect;
        const isForced =
          lastEffect?.type === "forced" ||
          lastEffect?.description?.toLowerCase().includes("forced") ||
          lastEffect?.description?.toLowerCase().includes("discard from compost");
        if (isForced) {
          play("forced_play", isActivePlayer);
        } else {
          play("action_immediate", isActivePlayer);
        }
      }
    }

    // ── 6. Deck refill — discard pile collapsed back into draw pile ────────
    if (
      curr.deckLen > 0 &&
      prev.deckLen > 0 &&
      curr.discardLen < prev.discardLen - 5 &&
      curr.deckLen > prev.deckLen + 5
    ) {
      play("deck_refill", isActivePlayer);
    }
  }, [gameState, localPlayerId, play, startAmbient, stopAmbient]);

  // Sync ambient with ongoing card on mount / reconnect
  useEffect(() => {
    if (!gameState) return;
    if (gameState.ongoingActionCard) {
      startAmbient();
    } else {
      stopAmbient();
    }
  }, [!!gameState?.ongoingActionCard]); // eslint-disable-line react-hooks/exhaustive-deps

  return { muted, toggleMute };
}
