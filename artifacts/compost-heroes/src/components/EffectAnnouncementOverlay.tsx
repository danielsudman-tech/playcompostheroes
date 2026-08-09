import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, MoveRight, RefreshCcw, Layers, Ban, CircleDot, Info, X } from "lucide-react";
import { assetUrl } from "@/lib/assetUrl";
import { cn } from "@/lib/utils";

export interface EffectEvent {
  kind: "draw" | "discard" | "transfer" | "swap" | "skip" | "pile_shift" | "modifier" | "info";
  playerIds?: string[];
  text: string;
}

export interface EffectAnnouncement {
  id: string;
  cardId: string;
  cardName: string;
  cardText: string;
  imageKey: string | null;
  playedById: string;
  playedByName: string;
  outcome: string[];
  events: EffectEvent[];
}

const EVENT_ICON: Record<EffectEvent["kind"], typeof Sparkles> = {
  draw: Layers,
  discard: RefreshCcw,
  transfer: MoveRight,
  swap: MoveRight,
  skip: Ban,
  pile_shift: RefreshCcw,
  modifier: CircleDot,
  info: Info,
};

const EVENT_COLOR: Record<EffectEvent["kind"], string> = {
  draw: "text-green-600 bg-green-50 border-green-200",
  discard: "text-red-600 bg-red-50 border-red-200",
  transfer: "text-blue-600 bg-blue-50 border-blue-200",
  swap: "text-blue-600 bg-blue-50 border-blue-200",
  skip: "text-orange-600 bg-orange-50 border-orange-200",
  pile_shift: "text-purple-600 bg-purple-50 border-purple-200",
  modifier: "text-amber-600 bg-amber-50 border-amber-200",
  info: "text-muted-foreground bg-muted/50 border-border",
};

/**
 * Facilitated mode: rich card-effect announcement shown to ALL players.
 * Shows the played card, its yellow effect text, plain-language outcome,
 * and spectator-friendly event badges (transfers, discards, draws…).
 */
export function EffectAnnouncementOverlay({ effect }: { effect: EffectAnnouncement | null | undefined }) {
  const [visible, setVisible] = useState(false);
  const [current, setCurrent] = useState<EffectAnnouncement | null>(null);
  const lastIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!effect || effect.id === lastIdRef.current) return;
    lastIdRef.current = effect.id;
    setCurrent(effect);
    setVisible(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(false), 7000);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [effect?.id]);

  return (
    <AnimatePresence>
      {visible && current && (
        <motion.div
          key={current.id}
          initial={{ opacity: 0, y: -30, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -15, scale: 0.97 }}
          transition={{ type: "spring", bounce: 0.3, duration: 0.45 }}
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[85] w-[min(92vw,26rem)]"
        >
          <div className="bg-card/97 backdrop-blur-lg border border-border shadow-2xl rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 bg-primary/10 border-b border-border">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-primary">
                <Sparkles className="w-3.5 h-3.5" />
                {current.playedByName} played a card
              </div>
              <button
                onClick={() => setVisible(false)}
                className="text-muted-foreground hover:text-foreground p-0.5 rounded-full hover:bg-muted transition-colors"
                aria-label="Dismiss"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="p-3 flex gap-3">
              {current.imageKey ? (
                <div className="w-16 h-24 rounded-lg overflow-hidden border-2 border-border shrink-0 shadow-md">
                  <img src={assetUrl(current.imageKey)} alt={current.cardName} className="w-full h-full object-cover" />
                </div>
              ) : (
                <div className="w-16 h-24 rounded-lg border-2 border-border bg-muted flex items-center justify-center shrink-0 p-1 text-center">
                  <span className="text-[9px] font-bold leading-tight">{current.cardName}</span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="font-display font-bold text-base leading-tight text-foreground">{current.cardName}</div>
                {current.cardText && (
                  <div className="mt-1 text-[11px] leading-snug font-medium bg-yellow-100/80 dark:bg-yellow-900/30 border border-yellow-300/60 text-yellow-900 dark:text-yellow-200 rounded-md px-2 py-1">
                    {current.cardText}
                  </div>
                )}
                {current.outcome.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {current.outcome.slice(-4).map((line, i) => (
                      <li key={i} className="text-[11px] text-muted-foreground leading-snug">• {line}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {current.events.length > 0 && (
              <div className="px-3 pb-3 flex flex-wrap gap-1.5">
                {current.events.slice(0, 6).map((ev, i) => {
                  const Icon = EVENT_ICON[ev.kind] ?? Info;
                  return (
                    <span
                      key={i}
                      className={cn(
                        "inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border",
                        EVENT_COLOR[ev.kind] ?? EVENT_COLOR.info
                      )}
                    >
                      <Icon className="w-3 h-3 shrink-0" />
                      {ev.text}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
