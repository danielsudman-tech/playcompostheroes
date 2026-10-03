export interface TimerInput {
  seconds?: number;
  deadlineAt?: number | null;
  remainingMs?: number | null;
  paused?: boolean;
  isActor: boolean;
  now: number;
}
export interface TimerView {
  visible: boolean;
  running: boolean;
  paused: boolean;
  remainingMs: number;
  urgent: boolean;
}
export const URGENT_MS = 10_000;

/** Pure display math; never touches the network. */
export function computeTimerView(i: TimerInput): TimerView {
  const off = { visible: false, running: false, paused: false, remainingMs: 0, urgent: false };
  if (!i.seconds) return off;
  const running = !i.paused && i.deadlineAt != null && i.remainingMs == null;
  const remaining = running ? Math.max(0, i.deadlineAt! - i.now) : i.remainingMs ?? null;
  if (remaining == null) return off;
  return {
    visible: true,
    running,
    paused: !running,
    remainingMs: remaining,
    urgent: running && i.isActor && remaining <= URGENT_MS,
  };
}

/** True when a cue should fire: urgent and not yet cued for this deadline key. */
export function shouldCue(urgent: boolean, key: string, lastCued: string | null) {
  return urgent && key !== lastCued;
}

/** Urgent emphasis/sound is for a required HUMAN actor only; bots (incl. a covered own seat) never cue. */
export function isTimerActor(actorId: string | null | undefined, localId: string | null | undefined, actorIsBot: boolean) {
  return !!actorId && actorId === localId && !actorIsBot;
}
