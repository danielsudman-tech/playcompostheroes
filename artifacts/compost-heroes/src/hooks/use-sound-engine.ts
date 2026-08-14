/**
 * Compost Heroes — Nature-inspired Web Audio synthesizer
 *
 * Every sound is built from noise textures + short tonal shapes —
 * no oscillator drones. Feel: earthy thuds, water drops, leaf rustles, wind.
 */
import { useCallback, useEffect, useRef, useState } from "react";

// ─── Layer / function mapping ────────────────────────────────────────────────

export const LAYER_FUNCTIONS = ["Moisture", "Carbon", "Decomposer", "Nitrogen", "Airflow"] as const;
export type LayerFunction = (typeof LAYER_FUNCTIONS)[number];

const LAYER_INDEX: Partial<Record<string, number>> = {
  Moisture: 0, Carbon: 1, Decomposer: 2, Nitrogen: 3, Airflow: 4,
};
export function layerIndex(fn: string): number {
  return LAYER_INDEX[fn] ?? 0;
}

// ─── Sound event type ────────────────────────────────────────────────────────

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

// Duck factors for non-active players (0 = silent, 1 = full)
const DUCK: Record<SoundEvent, number> = {
  draw: 0,
  hero_new_layer: 0.45,
  hero_stacking: 0.45,
  action_immediate: 0.45,
  ongoing_place: 0.95,
  ongoing_clear: 0.95,
  layer_complete: 1.0,
  win: 1.0,
  forced_play: 0.65,
  discard_limit: 0,
  deck_refill: 0.25,
  turn_to_me: 1.0,
};

/**
 * Events that carry game-state information and must always be audible,
 * even when the player has toggled the mute button ("effects off" mode).
 * Per Build Notes §5: layer_complete, win, ongoing_place, ongoing_clear
 * are full-volume-for-everyone signals, not ambient/effect audio.
 */
const UNMUTABLE: ReadonlySet<SoundEvent> = new Set<SoundEvent>([
  "layer_complete",
  "win",
  "ongoing_place",
  "ongoing_clear",
]);

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSoundEngine() {
  const [muted, setMuted] = useState(
    () => localStorage.getItem("ch-muted") === "1"
  );
  const ctxRef = useRef<AudioContext | null>(null);
  const ambientRef = useRef<{ osc: OscillatorNode; gain: GainNode } | null>(null);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      localStorage.setItem("ch-muted", next ? "1" : "0");
      return next;
    });
  }, []);

  const getCtx = useCallback((): AudioContext | null => {
    try {
      if (!ctxRef.current) {
        ctxRef.current = new (window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      }
      if (ctxRef.current.state === "suspended") ctxRef.current.resume();
      return ctxRef.current;
    } catch { return null; }
  }, []);

  // ── Core primitives ───────────────────────────────────────────────────────

  /** White noise buffer source through a bandpass/lowpass filter, volume-enveloped */
  function makeNoise(
    ctx: AudioContext,
    vol: number,
    start: number,
    duration: number,
    filterType: BiquadFilterType = "bandpass",
    filterFreq = 2000,
    filterQ = 1.5,
    attackTime = 0.005,
  ) {
    const bufSize = Math.ceil(ctx.sampleRate * (duration + 0.05));
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = filterType;
    filt.frequency.value = filterFreq;
    filt.Q.value = filterQ;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(vol, start + attackTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
    src.start(start); src.stop(start + duration + 0.05);
  }

  /** Amplitude-modulated noise — gives a "crunchy" or "chewing" texture */
  function makeCrunchNoise(
    ctx: AudioContext,
    vol: number,
    start: number,
    duration: number,
    filterFreq = 1200,
    modRate = 12,
  ) {
    const bufSize = Math.ceil(ctx.sampleRate * (duration + 0.05));
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.value = filterFreq;
    filt.Q.value = 2;

    // Modulator drives the gain — makes it choppy/crunchy
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    mod.frequency.value = modRate;
    modGain.gain.value = 0.4;
    mod.connect(modGain);

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.0001, start);
    masterGain.gain.linearRampToValueAtTime(vol, start + 0.02);
    masterGain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    src.connect(filt); filt.connect(masterGain);
    modGain.connect(masterGain.gain);
    masterGain.connect(ctx.destination);

    mod.start(start); mod.stop(start + duration + 0.05);
    src.start(start); src.stop(start + duration + 0.05);
  }

  /** Short pitched sine with fast attack — water-drop / tap feel */
  function makeWaterDrop(
    ctx: AudioContext,
    vol: number,
    start: number,
    freq = 1800,
    decay = 0.35,
  ) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    // Brief pitch bend downward — that "plink" character
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.65, start + decay * 0.6);
    gain.gain.setValueAtTime(vol, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + decay);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(start); osc.stop(start + decay + 0.02);
  }

  /** Low-frequency thud — a pillow-soft impact from filtered noise + low tone */
  function makeThud(
    ctx: AudioContext,
    vol: number,
    start: number,
    freq = 80,
    duration = 0.28,
  ) {
    // Low-pass noise layer
    makeNoise(ctx, vol * 0.55, start, duration, "lowpass", 180, 1, 0.003);
    // Sub-bass sine
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, start + duration * 0.7);
    gain.gain.setValueAtTime(vol * 0.5, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(start); osc.stop(start + duration + 0.02);
  }

  // ── Five layer nature tones ───────────────────────────────────────────────
  //  0 Moisture   — water drop (high plinking sine)
  //  1 Carbon     — hollow wood knock (filtered thud)
  //  2 Decomposer — organic leaf crunch + mid tone
  //  3 Nitrogen   — sharp grass snap (short broadband crack)
  //  4 Airflow    — breathy wind tone (high sine + soft noise)

  function playLayerTone(ctx: AudioContext, idx: number, vol: number, t: number) {
    switch (idx) {
      case 0: { // Moisture — water drop
        makeWaterDrop(ctx, vol * 0.7, t, 2100, 0.45);
        makeWaterDrop(ctx, vol * 0.25, t + 0.04, 3200, 0.25); // overtone shimmer
        break;
      }
      case 1: { // Carbon — wood knock
        makeNoise(ctx, vol * 0.55, t, 0.18, "bandpass", 420, 3, 0.002);
        makeThud(ctx, vol * 0.45, t, 110, 0.22);
        break;
      }
      case 2: { // Decomposer — leaf crunch
        makeCrunchNoise(ctx, vol * 0.6, t, 0.22, 900, 16);
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(330, t);
        g.gain.setValueAtTime(vol * 0.3, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(t + 0.03); osc.stop(t + 0.42);
        break;
      }
      case 3: { // Nitrogen — grass snap / click
        makeNoise(ctx, vol * 0.7, t, 0.08, "highpass", 2500, 0.8, 0.001);
        makeNoise(ctx, vol * 0.3, t + 0.04, 0.1, "bandpass", 1200, 2, 0.001);
        break;
      }
      case 4: { // Airflow — breathy wind chime
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(1047, t);
        osc.frequency.linearRampToValueAtTime(980, t + 0.6);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(vol * 0.35, t + 0.07);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(t); osc.stop(t + 0.77);
        makeNoise(ctx, vol * 0.12, t, 0.6, "bandpass", 3800, 0.5, 0.06);
        break;
      }
    }
  }

  // ── Main play ─────────────────────────────────────────────────────────────

  const play = useCallback(
    (event: SoundEvent, isActivePlayer: boolean, extra?: { layerIdx?: number }) => {
      // Unmutable events bypass the mute toggle — they carry game-state info
      // that every player needs to hear regardless of their preference.
      if (muted && !UNMUTABLE.has(event)) return;

      const ctx = getCtx();
      if (!ctx) return;

      const duckFactor = DUCK[event];
      const vol = isActivePlayer ? 1.0 : duckFactor;
      if (vol <= 0) return;

      const t = ctx.currentTime;

      try {
        switch (event) {
          case "draw": {
            // Leaf/paper riffle — bandpass noise burst
            makeNoise(ctx, vol * 0.22, t, 0.14, "bandpass", 4500, 1.2, 0.002);
            makeNoise(ctx, vol * 0.1, t + 0.04, 0.1, "bandpass", 3000, 2, 0.004);
            break;
          }
          case "hero_new_layer": {
            // Organic squish/plop — low thud + slight wet crunch
            makeThud(ctx, vol * 0.8, t, 75, 0.32);
            makeCrunchNoise(ctx, vol * 0.18, t + 0.04, 0.16, 600, 20);
            break;
          }
          case "hero_stacking": {
            // Double squish — two thuds with different character
            makeThud(ctx, vol * 0.75, t, 85, 0.25);
            makeThud(ctx, vol * 0.6, t + 0.14, 65, 0.22);
            break;
          }
          case "action_immediate": {
            // Whoosh/swish — swept bandpass noise
            const bufSize = Math.ceil(ctx.sampleRate * 0.28);
            const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
            const data = buf.getChannelData(0);
            for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
            const src = ctx.createBufferSource();
            src.buffer = buf;
            const filt = ctx.createBiquadFilter();
            filt.type = "bandpass";
            filt.frequency.setValueAtTime(300, t);
            filt.frequency.exponentialRampToValueAtTime(3500, t + 0.14);
            filt.frequency.exponentialRampToValueAtTime(800, t + 0.28);
            filt.Q.value = 1;
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.0001, t);
            gain.gain.linearRampToValueAtTime(vol * 0.32, t + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
            src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
            src.start(t); src.stop(t + 0.3);
            break;
          }
          case "ongoing_place": {
            // Leaves settling — slow-attack mid noise with a soft tone settling in
            makeNoise(ctx, vol * 0.18, t, 0.55, "bandpass", 1600, 0.8, 0.12);
            makeNoise(ctx, vol * 0.1, t + 0.2, 0.4, "bandpass", 2800, 1, 0.06);
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            osc.type = "sine";
            osc.frequency.setValueAtTime(220, t);
            osc.frequency.linearRampToValueAtTime(330, t + 0.5);
            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(vol * 0.15, t + 0.3);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
            osc.connect(g); g.connect(ctx.destination);
            osc.start(t); osc.stop(t + 0.67);
            break;
          }
          case "ongoing_clear": {
            // Quick flutter — brief high-ish noise burst
            makeNoise(ctx, vol * 0.2, t, 0.18, "bandpass", 2200, 1.5, 0.003);
            makeNoise(ctx, vol * 0.1, t + 0.06, 0.12, "highpass", 3500, 1, 0.003);
            break;
          }
          case "layer_complete": {
            const idx = extra?.layerIdx ?? 0;
            playLayerTone(ctx, idx, vol, t);
            break;
          }
          case "win": {
            // All 5 layer tones in sequence, then a broad wind swell
            for (let i = 0; i < 5; i++) {
              playLayerTone(ctx, i, vol * 0.75, t + i * 0.26);
            }
            // Closing: moisture + airflow together
            playLayerTone(ctx, 0, vol * 0.5, t + 5 * 0.26 + 0.1);
            playLayerTone(ctx, 4, vol * 0.45, t + 5 * 0.26 + 0.1);
            // Broad wind swell underneath
            makeNoise(ctx, vol * 0.12, t + 0.3, 1.6, "lowpass", 500, 0.5, 0.4);
            break;
          }
          case "forced_play": {
            // Descending squish — heavier thud pitching down
            makeThud(ctx, vol * 0.85, t, 95, 0.35);
            makeNoise(ctx, vol * 0.2, t + 0.05, 0.2, "bandpass", 700, 2, 0.01);
            makeCrunchNoise(ctx, vol * 0.15, t + 0.12, 0.15, 500, 10);
            break;
          }
          case "discard_limit": {
            // Soft leaf flick — very brief high-freq noise
            makeNoise(ctx, vol * 0.15, t, 0.1, "bandpass", 5000, 1, 0.001);
            break;
          }
          case "deck_refill": {
            // Shuffling leaves — mid noise, longer
            makeNoise(ctx, vol * 0.2, t, 0.5, "bandpass", 2200, 0.8, 0.03);
            makeNoise(ctx, vol * 0.14, t + 0.1, 0.4, "bandpass", 3500, 1.2, 0.05);
            makeCrunchNoise(ctx, vol * 0.1, t + 0.15, 0.3, 1500, 18);
            break;
          }
          case "turn_to_me": {
            // Two water drops — ready notification
            makeWaterDrop(ctx, vol * 0.5, t, 1600, 0.3);
            makeWaterDrop(ctx, vol * 0.65, t + 0.22, 2000, 0.38);
            break;
          }
        }
      } catch {
        // Audio not available
      }
    },
    [muted, getCtx] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── Ongoing ambient (soft wind breath) ───────────────────────────────────

  const startAmbient = useCallback(() => {
    if (muted) return;
    const ctx = getCtx();
    if (!ctx || ambientRef.current) return;
    try {
      // Slow-breathing low-pass noise — forest floor ambience
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sawtooth"; // slightly richer than sine for wind feel
      osc.frequency.setValueAtTime(48, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(52, ctx.currentTime + 5);
      osc.frequency.linearRampToValueAtTime(46, ctx.currentTime + 10);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.025, ctx.currentTime + 2.0);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      ambientRef.current = { osc, gain };
    } catch { /* ignore */ }
  }, [muted, getCtx]);

  const stopAmbient = useCallback(() => {
    const ctx = ctxRef.current;
    const amb = ambientRef.current;
    if (!ctx || !amb) return;
    try {
      amb.gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 1.2);
      amb.osc.stop(ctx.currentTime + 1.3);
    } catch { /* ignore */ }
    ambientRef.current = null;
  }, []);

  useEffect(() => { if (muted) stopAmbient(); }, [muted, stopAmbient]);

  useEffect(() => {
    return () => {
      stopAmbient();
      try { ctxRef.current?.close(); } catch { /* ignore */ }
    };
  }, [stopAmbient]);

  return { play, startAmbient, stopAmbient, muted, toggleMute };
}
