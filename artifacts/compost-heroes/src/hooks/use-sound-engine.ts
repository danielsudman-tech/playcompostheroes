/**
 * Compost Heroes — Web Audio synthesizer
 *
 * One asset per event, volume scaled by isActivePlayer.
 * No external files — everything is synthesized in-browser.
 */
import { useCallback, useEffect, useRef, useState } from "react";

// ─── Layer / function mapping ────────────────────────────────────────────────

export const LAYER_FUNCTIONS = ["Moisture", "Carbon", "Decomposer", "Nitrogen", "Airflow"] as const;
export type LayerFunction = (typeof LAYER_FUNCTIONS)[number];

const LAYER_INDEX: Partial<Record<string, number>> = {
  Moisture: 0,
  Carbon: 1,
  Decomposer: 2,
  Nitrogen: 3,
  Airflow: 4,
};

export function layerIndex(fn: string): number {
  return LAYER_INDEX[fn] ?? 0;
}

// ─── Duck factors for non-active players ────────────────────────────────────

export type SoundEvent =
  | "draw"
  | "hero_new_layer"
  | "hero_stacking"
  | "action_immediate"
  | "ongoing_place"
  | "ongoing_clear"
  | "layer_complete"
  | "win"
  | "forced_play"
  | "discard_limit"
  | "deck_refill"
  | "turn_to_me";

const DUCK: Record<SoundEvent, number> = {
  draw: 0,
  hero_new_layer: 0.45,
  hero_stacking: 0.45,
  action_immediate: 0.45,
  ongoing_place: 0.95,
  ongoing_clear: 0.95,
  layer_complete: 1.0,   // full for everyone — game-state info
  win: 1.0,              // full for everyone
  forced_play: 0.65,
  discard_limit: 0,
  deck_refill: 0.25,
  turn_to_me: 1.0,       // only fires for the incoming active player
};

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSoundEngine() {
  const [muted, setMuted] = useState(
    () => localStorage.getItem("ch-muted") === "1"
  );
  const ctxRef = useRef<AudioContext | null>(null);
  const ambientRef = useRef<{
    osc: OscillatorNode;
    gain: GainNode;
  } | null>(null);

  // Persist mute preference
  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      localStorage.setItem("ch-muted", next ? "1" : "0");
      return next;
    });
  }, []);

  // Lazily create / resume context (browsers need a user-gesture first)
  const getCtx = useCallback((): AudioContext | null => {
    try {
      if (!ctxRef.current) {
        ctxRef.current = new (window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext)();
      }
      if (ctxRef.current.state === "suspended") {
        ctxRef.current.resume();
      }
      return ctxRef.current;
    } catch {
      return null;
    }
  }, []);

  // ── Synthesize helpers ────────────────────────────────────────────────────

  function makeSine(
    ctx: AudioContext,
    freq: number,
    vol: number,
    start: number,
    duration: number,
    freqEnd?: number,
    attackTime = 0.005
  ) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, start);
    if (freqEnd !== undefined) {
      osc.frequency.linearRampToValueAtTime(freqEnd, start + duration * 0.7);
    }
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(vol, start + attackTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.01);
  }

  function makeNoise(
    ctx: AudioContext,
    vol: number,
    start: number,
    duration: number,
    lowpass = 2000
  ) {
    const bufSize = Math.ceil(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = lowpass;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start(start);
    src.stop(start + duration + 0.01);
  }

  // ── 5 layer tones ──────────────────────────────────────────────────────────
  //  0 Moisture   — bell-like (880 Hz, long decay)
  //  1 Carbon     — deep wood (220 Hz, triangle, short)
  //  2 Decomposer — organic tone + noise (440 Hz)
  //  3 Nitrogen   — bright pluck (587 Hz, sawtooth, fast)
  //  4 Airflow    — airy (1047 Hz, slow attack)

  function playLayerTone(ctx: AudioContext, idx: number, vol: number, t: number) {
    switch (idx) {
      case 0: { // Moisture — bell
        makeSine(ctx, 880, vol * 0.6, t, 1.1, undefined, 0.003);
        makeSine(ctx, 1320, vol * 0.25, t, 0.7, undefined, 0.003);
        break;
      }
      case 1: { // Carbon — deep wood thud
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(220, t);
        osc.frequency.exponentialRampToValueAtTime(80, t + 0.18);
        g.gain.setValueAtTime(vol * 0.7, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(t); osc.stop(t + 0.36);
        break;
      }
      case 2: { // Decomposer — rustle + tone
        makeNoise(ctx, vol * 0.15, t, 0.25, 1500);
        makeSine(ctx, 440, vol * 0.45, t, 0.7, undefined, 0.02);
        break;
      }
      case 3: { // Nitrogen — bright pluck
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(587, t);
        g.gain.setValueAtTime(vol * 0.5, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(t); osc.stop(t + 0.29);
        break;
      }
      case 4: { // Airflow — breathy wind chime
        makeSine(ctx, 1047, vol * 0.4, t, 1.2, undefined, 0.08);
        makeSine(ctx, 1568, vol * 0.2, t + 0.12, 0.9, undefined, 0.06);
        break;
      }
    }
  }

  // ── Main play function ─────────────────────────────────────────────────────

  const play = useCallback(
    (event: SoundEvent, isActivePlayer: boolean, extra?: { layerIdx?: number }) => {
      if (muted) return;
      const ctx = getCtx();
      if (!ctx) return;

      const duckFactor = DUCK[event];
      const vol = isActivePlayer ? 1.0 : duckFactor;
      if (vol <= 0) return;

      const t = ctx.currentTime;

      try {
        switch (event) {
          case "draw": {
            // Light paper riffle — short noise burst + slight pitch rise
            makeNoise(ctx, vol * 0.18, t, 0.18, 3000);
            makeSine(ctx, 330, vol * 0.1, t, 0.18, 520);
            break;
          }

          case "hero_new_layer": {
            // Warm organic plop — low sine thud with soft overtone
            makeSine(ctx, 180, vol * 0.55, t, 0.35, 90, 0.008);
            makeSine(ctx, 360, vol * 0.2, t, 0.25, undefined, 0.01);
            break;
          }

          case "hero_stacking": {
            // Double thud — two low hits offset
            makeSine(ctx, 160, vol * 0.55, t, 0.28, 80, 0.008);
            makeSine(ctx, 200, vol * 0.45, t + 0.12, 0.28, 90, 0.008);
            break;
          }

          case "action_immediate": {
            // Quick zap — sawtooth burst with fast sweep
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            osc.type = "sawtooth";
            osc.frequency.setValueAtTime(300, t);
            osc.frequency.linearRampToValueAtTime(700, t + 0.08);
            osc.frequency.linearRampToValueAtTime(400, t + 0.18);
            g.gain.setValueAtTime(vol * 0.35, t);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
            osc.connect(g); g.connect(ctx.destination);
            osc.start(t); osc.stop(t + 0.23);
            break;
          }

          case "ongoing_place": {
            // Rising settle-in — glide from low to mid
            makeSine(ctx, 200, vol * 0.3, t, 0.6, 440, 0.04);
            makeSine(ctx, 400, vol * 0.15, t + 0.35, 0.4, 660, 0.04);
            break;
          }

          case "ongoing_clear": {
            // Short descending reset
            makeSine(ctx, 520, vol * 0.25, t, 0.22, 280, 0.005);
            makeNoise(ctx, vol * 0.06, t + 0.1, 0.12, 800);
            break;
          }

          case "layer_complete": {
            // Layer-specific chime (always full volume — game-state info)
            const idx = extra?.layerIdx ?? 0;
            playLayerTone(ctx, idx, vol, t);
            break;
          }

          case "win": {
            // Win fanfare — all 5 layer tones in sequence
            for (let i = 0; i < 5; i++) {
              playLayerTone(ctx, i, vol * 0.7, t + i * 0.28);
            }
            // Finishing chord — Moisture + Airflow together
            playLayerTone(ctx, 0, vol * 0.5, t + 5 * 0.28);
            playLayerTone(ctx, 4, vol * 0.4, t + 5 * 0.28);
            break;
          }

          case "forced_play": {
            // Low descending "uh-oh" — two notes stepping down
            makeSine(ctx, 280, vol * 0.35, t, 0.28, 200, 0.01);
            makeSine(ctx, 200, vol * 0.35, t + 0.22, 0.3, 140, 0.01);
            break;
          }

          case "discard_limit": {
            // Soft flick — very brief high noise
            makeNoise(ctx, vol * 0.1, t, 0.1, 4000);
            break;
          }

          case "deck_refill": {
            // Bigger shuffle — mid noise burst, longer
            makeNoise(ctx, vol * 0.22, t, 0.45, 2500);
            makeNoise(ctx, vol * 0.12, t + 0.15, 0.35, 1800);
            break;
          }

          case "turn_to_me": {
            // Friendly ping — two ascending notes
            makeSine(ctx, 440, vol * 0.25, t, 0.25, undefined, 0.01);
            makeSine(ctx, 587, vol * 0.3, t + 0.18, 0.35, undefined, 0.01);
            break;
          }
        }
      } catch {
        // Audio not available — silently ignore
      }
    },
    [muted, getCtx] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── Ongoing ambient ───────────────────────────────────────────────────────

  const startAmbient = useCallback(() => {
    if (muted) return;
    const ctx = getCtx();
    if (!ctx || ambientRef.current) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(55, ctx.currentTime); // Low A drone
      // Slow LFO vibrato feel — manual via freq automation
      osc.frequency.linearRampToValueAtTime(58, ctx.currentTime + 4);
      osc.frequency.linearRampToValueAtTime(55, ctx.currentTime + 8);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.04, ctx.currentTime + 1.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      ambientRef.current = { osc, gain };
    } catch {
      // ignore
    }
  }, [muted, getCtx]);

  const stopAmbient = useCallback(() => {
    const ctx = ctxRef.current;
    const amb = ambientRef.current;
    if (!ctx || !amb) return;
    try {
      amb.gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 1.0);
      amb.osc.stop(ctx.currentTime + 1.1);
    } catch {
      // ignore
    }
    ambientRef.current = null;
  }, []);

  // Stop ambient when muted
  useEffect(() => {
    if (muted) stopAmbient();
  }, [muted, stopAmbient]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAmbient();
      try {
        ctxRef.current?.close();
      } catch {
        // ignore
      }
    };
  }, [stopAmbient]);

  return { play, startAmbient, stopAmbient, muted, toggleMute };
}
