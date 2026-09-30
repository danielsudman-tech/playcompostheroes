/**
 * Compost Heroes — Web Audio synthesizer for short, meaningful game cues.
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

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      localStorage.setItem("ch-muted", next ? "1" : "0");
      return next;
    });
  }, []);

  const getCtx = useCallback((): AudioContext | null => {
    try {
      if (!ctxRef.current || ctxRef.current.state === "closed") {
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

  useEffect(() => {
    return () => {
      const context = ctxRef.current;
      ctxRef.current = null;
      if (context && context.state !== "closed") void context.close().catch(() => {});
    };
  }, []);

  return { play, muted, toggleMute };
}
