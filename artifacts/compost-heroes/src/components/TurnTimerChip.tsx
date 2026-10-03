import { useEffect, useRef, useState } from "react";
import { Timer, Pause } from "lucide-react";
import { useSoundEngine } from "@/hooks/use-sound-engine";
import { cn } from "@/lib/utils";
import { computeTimerView, shouldCue } from "@/lib/turnTimerCore";

export interface TurnTimerFields {
  turnTimerSeconds?: number;
  turnDeadlineAt?: number | null;
  turnTimerRemainingMs?: number | null;
  turnDeadlineKey?: string | null;
}

export const TURN_TIMER_OPTIONS = [0, 30, 60, 90, 120] as const;
export const turnTimerLabel = (s?: number) => (s ? `${s} sec per turn` : "Off");

function fmt(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Purely local countdown: no requests, only display. */
export function TurnTimerChip({
  game, paused, isActor, audible = true, testId = "turn-timer", className,
}: {
  game: TurnTimerFields;
  paused?: boolean;
  /** True when this viewer owns the pending decision or current turn. */
  isActor: boolean;
  /** Only one chip per page should be audible. */
  audible?: boolean;
  testId?: string;
  className?: string;
}) {
  const deadline = game.turnDeadlineAt ?? null;
  const running = !paused && deadline != null && game.turnTimerRemainingMs == null;
  const [now, setNow] = useState(() => Date.now());
  const { play } = useSoundEngine();
  const cued = useRef<string | null>(null);

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [running, deadline]);

  const view = computeTimerView({
    seconds: game.turnTimerSeconds, deadlineAt: deadline, remainingMs: game.turnTimerRemainingMs,
    paused, isActor, now,
  });
  const urgent = view.urgent;
  const cueKey = game.turnDeadlineKey ?? String(deadline);

  useEffect(() => {
    if (!audible || !shouldCue(urgent, cueKey, cued.current)) return;
    cued.current = cueKey;
    try {
      if (localStorage.getItem("ch-muted") !== "1") play("action_card", true);
    } catch {}
  }, [audible, urgent, cueKey, play]);

  if (!view.visible) return null;
  const remaining = view.remainingMs;
  const isPaused = view.paused;
  return (
    <div
      role="timer"
      aria-label={`Turn timer ${fmt(remaining)}${isPaused ? ", paused" : ""}`}
      data-testid={testId}
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-bold tabular-nums transition-colors",
        urgent
          ? "bg-destructive/10 border-destructive/50 text-destructive motion-safe:animate-pulse"
          : isActor && running
            ? "bg-primary/10 border-primary/40 text-primary"
            : "bg-card border-border text-muted-foreground",
        className,
      )}
    >
      {isPaused ? <Pause className="w-3.5 h-3.5" /> : <Timer className="w-3.5 h-3.5" />}
      <span>{fmt(remaining)}</span>
      {isPaused && <span className="font-medium">paused</span>}
    </div>
  );
}

export function TurnTimerSelect({
  value, onChange, disabled, testId = "select-turn-timer", className,
}: { value: number; onChange: (v: number) => void; disabled?: boolean; testId?: string; className?: string }) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      data-testid={testId}
      aria-label="Turn timer"
      className={cn("h-10 rounded-xl border-2 border-border bg-background/50 px-3 text-sm font-bold focus:outline-none focus:border-primary/50", className)}
    >
      {TURN_TIMER_OPTIONS.map((s) => (
        <option key={s} value={s}>{s === 0 ? "Off" : `${s} sec`}</option>
      ))}
    </select>
  );
}
