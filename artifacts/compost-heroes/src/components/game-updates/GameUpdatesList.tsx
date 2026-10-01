import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { isHighlighted, type GameUpdate } from "@/lib/gameUpdates";

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function useHasFresh(updates: GameUpdate[]) {
  const now = useNow(updates.length > 0);
  return { now, fresh: updates.some((u) => isHighlighted(u, now)) };
}

/** Desktop: newest 3, non-scrolling, sits below ongoing and above turn controls. */
export function GameUpdatesList({ updates, onOpenRecap }: { updates: GameUpdate[]; onOpenRecap: () => void }) {
  const { now } = useHasFresh(updates);
  const shown = updates.slice(0, 3);
  return (
    <section aria-label="Recent updates" aria-live="polite" data-testid="game-updates-list"
      className="hidden md:block rounded-2xl border border-border bg-card/90 px-3 py-2 overflow-hidden">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Updates</h3>
        <button onClick={onOpenRecap} data-testid="button-updates-recap" className="text-[11px] font-bold text-primary hover:underline">Recap</button>
      </div>
      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground py-1">Nothing yet. Plays will show up here.</p>
      ) : (
        <ul className="space-y-1">
          {shown.map((u) => {
            const hot = isHighlighted(u, now);
            return (
              <li key={u.id} data-testid={`game-update-${u.id}`}
                className={cn("rounded-lg px-2 py-1 text-xs leading-snug border-l-4 transition-colors duration-700",
                  hot ? (u.personal ? "bg-amber-500/20 border-amber-500 text-foreground" : "bg-primary/10 border-primary text-foreground")
                      : "bg-transparent border-transparent text-muted-foreground")}>
                <p className="font-bold truncate">{u.title}</p>
                {u.detail && <p className="line-clamp-3">{u.detail}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Mobile: one-line strip above the hand, outside the drawer. Taps open Recap. */
export function GameUpdatesStrip({
  updates,
  onOpenRecap,
  children,
}: {
  updates: GameUpdate[];
  onOpenRecap: () => void;
  children?: ReactNode;
}) {
  const { now } = useHasFresh(updates);
  const latest = updates[0];
  if (!latest && !children) return null;
  const hot = latest ? isHighlighted(latest, now) : false;
  return (
    <div
      data-testid="button-updates-strip"
      aria-label="Latest game update"
      aria-live="polite"
      role="group"
      className={cn(
        "md:hidden w-full min-h-9 flex items-center gap-1 overflow-hidden px-2 text-xs border-t border-border transition-colors duration-700",
        hot ? (latest?.personal ? "bg-amber-500/20 text-foreground" : "bg-primary/10 text-foreground") : "bg-card/90 text-muted-foreground",
      )}
    >
      {latest ? (
        <button
          type="button"
          onClick={onOpenRecap}
          className="min-w-0 flex-1 flex items-center gap-2 py-1.5 text-left"
          aria-label={`${latest.title}${latest.detail ? `: ${latest.detail}` : ""}. Open Game Recap.`}
        >
          <span className="font-bold truncate">
            {latest.title}{latest.detail ? `: ${latest.detail}` : ""}
          </span>
          <span className="shrink-0 font-bold text-primary">Recap</span>
        </button>
      ) : (
        <span className="sr-only">No game updates yet</span>
      )}
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}
