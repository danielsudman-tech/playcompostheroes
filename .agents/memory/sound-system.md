---
name: Sound system architecture
description: How Compost Heroes sound effects are built and triggered — no audio files, pure Web Audio synthesis, state-diff detection.
---

## Architecture

Two hooks:
- `src/hooks/use-sound-engine.ts` — synthesizer + mute toggle. Single `AudioContext` reused across calls (lazy init). Exposes `play(event, isActivePlayer, extra?)`, `startAmbient()`, `stopAmbient()`, `muted`, `toggleMute`.
- `src/hooks/use-game-sounds.ts` — diffs consecutive `GameState` snapshots to detect events and call `play`. Returns `{ muted, toggleMute }` for UI.

Both `Game.tsx` and `FacilitatedGame.tsx` call `useGameSounds(gameState, localPlayerId)` and render a mute icon button using the returned toggle.

## Volume model

`play(event, isActivePlayer)` applies a per-event duck factor when `!isActivePlayer`:
- 0% (silent): draw, discard_limit
- 25%: deck_refill
- 45%: hero_new_layer, hero_stacking, action_immediate
- 65%: forced_play
- 95%: ongoing_place, ongoing_clear
- 100%: layer_complete, win, turn_to_me

## Mute

Persisted to `localStorage` as `ch-muted = "1"`. Stopping ambient on mute is handled inside the engine hook.

## Sound detection approach

All sounds triggered by state diff (prev vs curr snapshot), not action dispatch. Snapshot tracks: phase, currentPlayerIndex, winner, ongoingId, per-player {handLen, pileByFn, pileLen}, discardLen, deckLen.

Key detections:
- Turn change → `turn_to_me` (dominant event, returns early to avoid stacking)
- Win: phase changed to `game_over`
- Ongoing: `ongoingId` changed
- Draw: my hand grew
- Hero play: player's compostPile grew — new function = `hero_new_layer` + `layer_complete` chime (220ms delay); repeat function = `hero_stacking`
- Action play: discard pile grew with an action card on top; checks `lastEffect` for forced/self-harm
- Deck refill: deckLen jumped up AND discardLen dropped

## Layer tones (5 unique synthesized tones)

- 0 Moisture: bell-like sine at 880 Hz, long decay
- 1 Carbon: deep triangle at 220 Hz → 80 Hz
- 2 Decomposer: noise burst + sine at 440 Hz
- 3 Nitrogen: sawtooth pluck at 587 Hz
- 4 Airflow: airy sine at 1047 Hz + harmonic at 1568 Hz

Win fanfare = all 5 layer tones sequenced 280ms apart, finishing chord of Moisture + Airflow.

**Why:** No external audio files keeps the app fast on shared camp devices/variable wifi. State-diff detection works for both classic and facilitated modes without needing typed SSE events.
