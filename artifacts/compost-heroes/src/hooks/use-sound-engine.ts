/**
 * Compost Heroes — Nature-inspired Web Audio synthesizer (Simplified)
 *
 * Five core sound events, one LFO-modulated ambient bed that shifts
 * through 3 frequency states on a slow cycle so it stays perceptible.
 * Feel: earthy thuds, leaf rustles, water drops, soft wind — playfully animated.
 */
import { useCallback, useEffect, useRef, useState } from "react";

// ─── Sound event type ────────────────────────────────────────────────────────

export type SoundEvent =
  | "hero_place"      // any hero placed in pile (new layer or stacking)
  | "draw_discard"    // draw a card, or discard to hand limit — same sound
  | "action_card"     // any action card played (immediate or ongoing)
  | "layer_complete"  // first hero on a previously-empty layer — full volume everyone
  | "win";            // player completes all 5 layers — full volume everyone

// Duck factors for non-active players (0 = silent, 1 = full)
const DUCK: Record<SoundEvent, number> = {
  hero_place:    0.45,
  draw_discard:  0,      // high-frequency, low-relevance — silent for waiting players
  action_card:   0.45,
  layer_complete: 1.0,   // carries info for everyone
  win:           1.0,
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
    cleanup: () => void;
  } | null>(null);

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

  // ── Primitives ────────────────────────────────────────────────────────────

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

  function makeThud(ctx: AudioContext, vol: number, start: number, freq = 80, duration = 0.28) {
    makeNoise(ctx, vol * 0.55, start, duration, "lowpass", 180, 1, 0.003);
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

  function makeChime(ctx: AudioContext, vol: number, start: number, freq = 1760, decay = 0.9) {
    // Clean bell-like sine with gentle pitch drift
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.92, start + decay * 0.5);
    gain.gain.setValueAtTime(vol, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + decay);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(start); osc.stop(start + decay + 0.05);
    // Soft second harmonic
    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.value = freq * 2.01;
    g2.gain.setValueAtTime(vol * 0.18, start);
    g2.gain.exponentialRampToValueAtTime(0.0001, start + decay * 0.4);
    osc2.connect(g2); g2.connect(ctx.destination);
    osc2.start(start); osc2.stop(start + decay * 0.45);
  }

  // ── Main play ─────────────────────────────────────────────────────────────

  const play = useCallback(
    (event: SoundEvent, isActivePlayer: boolean) => {
      if (muted) return;

      const ctx = getCtx();
      if (!ctx) return;

      const duckFactor = DUCK[event];
      const vol = isActivePlayer ? 1.0 : duckFactor;
      if (vol <= 0) return;

      const t = ctx.currentTime;

      try {
        switch (event) {
          case "hero_place": {
            // Earthy thud + light leaf-rustle, playful upward pitch-bend
            makeThud(ctx, vol * 0.8, t, 75, 0.30);
            makeNoise(ctx, vol * 0.14, t + 0.05, 0.18, "bandpass", 2800, 1.2, 0.004);
            // Upward pitch-bend: a brief bright chirp
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            osc.type = "sine";
            osc.frequency.setValueAtTime(320, t + 0.06);
            osc.frequency.exponentialRampToValueAtTime(680, t + 0.22);
            g.gain.setValueAtTime(vol * 0.12, t + 0.06);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
            osc.connect(g); g.connect(ctx.destination);
            osc.start(t + 0.06); osc.stop(t + 0.30);
            break;
          }

          case "draw_discard": {
            // Short, dry leaf-flick
            makeNoise(ctx, vol * 0.20, t, 0.12, "bandpass", 4800, 1.2, 0.002);
            makeNoise(ctx, vol * 0.08, t + 0.04, 0.08, "bandpass", 3200, 2, 0.003);
            break;
          }

          case "action_card": {
            // Short gust/whoosh — swept bandpass noise
            const bufSize = Math.ceil(ctx.sampleRate * 0.26);
            const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
            const data = buf.getChannelData(0);
            for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
            const src = ctx.createBufferSource();
            src.buffer = buf;
            const filt = ctx.createBiquadFilter();
            filt.type = "bandpass";
            filt.frequency.setValueAtTime(280, t);
            filt.frequency.exponentialRampToValueAtTime(3800, t + 0.13);
            filt.frequency.exponentialRampToValueAtTime(900, t + 0.26);
            filt.Q.value = 1;
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.0001, t);
            gain.gain.linearRampToValueAtTime(vol * 0.30, t + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
            src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
            src.start(t); src.stop(t + 0.28);
            break;
          }

          case "layer_complete": {
            // Single pleasant chime — one shared tone for every layer
            makeChime(ctx, vol * 0.65, t, 1760, 0.95);
            // Gentle leaf-rustle underneath to keep it earthy
            makeNoise(ctx, vol * 0.10, t, 0.35, "bandpass", 3500, 0.8, 0.04);
            break;
          }

          case "win": {
            // Short rustle-and-chime swell — quick, satisfying, not multi-part
            makeNoise(ctx, vol * 0.14, t, 0.5, "bandpass", 2500, 0.7, 0.06);
            makeChime(ctx, vol * 0.65, t + 0.10, 1760, 1.0);
            makeChime(ctx, vol * 0.50, t + 0.28, 2093, 0.85);
            makeChime(ctx, vol * 0.40, t + 0.46, 2637, 0.70);
            makeNoise(ctx, vol * 0.10, t + 0.3, 0.55, "lowpass", 500, 0.5, 0.18);
            break;
          }
        }
      } catch {
        // Audio not available
      }
    },
    [muted, getCtx] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── Ongoing ambient (LFO-modulated cycling wind tone) ────────────────────
  //
  // Three "states" cycle every 7.5 s (base → up → down → base …), giving a
  // slow perceptible shift without competing with game sounds.
  // Each layer function gets a distinct base pitch and modulation speed.
  // Called with no arg (or unknown fn) → defaults to Decomposer colour.

  const startAmbient = useCallback((layerFn?: string) => {
    if (muted || ambientRef.current) return;
    const ctx = getCtx();
    if (!ctx) return;
    try {
      // Per-function ambient colours ─────────────────────────────────────
      type AmbientColour = {
        base: number;       // oscillator base frequency (Hz)
        lfoRate: number;    // vibrato LFO speed (Hz)
        lfoDepth: number;   // vibrato depth (Hz ±)
        filterFreq: number; // lowpass cutoff
      };
      const COLOURS: Record<string, AmbientColour> = {
        Nitrogen:   { base: 65, lfoRate: 0.13, lfoDepth: 9,  filterFreq: 420 },
        Carbon:     { base: 42, lfoRate: 0.07, lfoDepth: 5,  filterFreq: 200 },
        Moisture:   { base: 55, lfoRate: 0.11, lfoDepth: 7,  filterFreq: 320 },
        Airflow:    { base: 62, lfoRate: 0.10, lfoDepth: 8,  filterFreq: 480 },
        Decomposer: { base: 50, lfoRate: 0.09, lfoDepth: 6,  filterFreq: 270 },
      };
      const colour: AmbientColour =
        COLOURS[layerFn ?? ""] ?? COLOURS.Decomposer;

      // Primary oscillator — sawtooth for a slightly rich wind tone
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = colour.base;

      // Vibrato LFO → oscillator frequency
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = colour.lfoRate;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = colour.lfoDepth;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      // Warmth lowpass filter
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = colour.filterFreq;
      filter.Q.value = 0.7;

      // Slow amplitude "breath" LFO (~12 s per breath cycle)
      const breathLfo = ctx.createOscillator();
      breathLfo.type = "sine";
      breathLfo.frequency.value = 0.08;
      const breathGain = ctx.createGain();
      breathGain.gain.value = 0.006;
      breathLfo.connect(breathGain);

      // Master gain with 2 s fade-in
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.026, ctx.currentTime + 2.0);

      osc.connect(filter);
      filter.connect(gain);
      breathGain.connect(gain.gain); // breath modulates amplitude
      gain.connect(ctx.destination);

      lfo.start();
      breathLfo.start();
      osc.start();

      // 3-state frequency cycle: base → up (+18 %) → down (−13 %) → repeat
      // Each step lasts 7.5 s; glide takes 3 s so the shift is gradual.
      const cycleFreqs = [colour.base, colour.base * 1.18, colour.base * 0.87];
      let cycleIndex = 0;
      const timer = setInterval(() => {
        if (!ambientRef.current) { clearInterval(timer); return; }
        cycleIndex = (cycleIndex + 1) % cycleFreqs.length;
        const now = ctx.currentTime;
        // Ramp the base pitch; LFO continues to wobble around the new centre
        osc.frequency.cancelScheduledValues(now);
        osc.frequency.setValueAtTime(osc.frequency.value, now);
        osc.frequency.linearRampToValueAtTime(cycleFreqs[cycleIndex], now + 3.0);
      }, 7500);

      ambientRef.current = {
        osc,
        gain,
        cleanup: () => {
          clearInterval(timer);
          try { lfo.stop(); } catch { /* ignore */ }
          try { breathLfo.stop(); } catch { /* ignore */ }
        },
      };
    } catch { /* ignore */ }
  }, [muted, getCtx]);

  const stopAmbient = useCallback(() => {
    const ctx = ctxRef.current;
    const amb = ambientRef.current;
    if (!ctx || !amb) return;
    try {
      amb.gain.gain.cancelScheduledValues(ctx.currentTime);
      amb.gain.gain.setValueAtTime(amb.gain.gain.value, ctx.currentTime);
      amb.gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 1.2);
      amb.osc.stop(ctx.currentTime + 1.3);
    } catch { /* ignore */ }
    amb.cleanup();
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
