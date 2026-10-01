import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, MoveRight, RefreshCcw, Layers, Ban, CircleDot, Info } from "lucide-react";
import { assetUrl } from "@/lib/assetUrl";
import { cn } from "@/lib/utils";
import {
  getEffectAnnouncementHeading,
  getEffectAnnouncementLevel,
  getPresentedEffectEvents,
  getPresentedPrivateFacts,
  type EffectAnnouncementData,
  type EffectAnnouncementEvent,
} from "@/lib/effectAnnouncements";

export type EffectEvent = EffectAnnouncementEvent;
export type EffectAnnouncement = EffectAnnouncementData;

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

const TRANSIENT_DURATION: Record<"routine" | "shared", number> = {
  routine: 3200,
  shared: 7000,
};

interface EffectAnnouncementOverlayProps {
  effect: EffectAnnouncement | null | undefined;
  /** The local seat id, used to keep that player's impacts visible until acknowledged. */
  localPlayerId?: string | null;
}

export function EffectAnnouncementOverlay({ effect, localPlayerId }: EffectAnnouncementOverlayProps) {
  const [queue, setQueue] = useState<EffectAnnouncement[]>([]);
  const seenIdsRef = useRef(new Set<string>());
  const current = queue[0] ?? null;
  const level = current ? getEffectAnnouncementLevel(current, localPlayerId) : null;

  useEffect(() => {
    if (!effect || seenIdsRef.current.has(effect.id)) return;
    seenIdsRef.current.add(effect.id);
    setQueue((pending) => [...pending, effect]);
  }, [effect]);

  useEffect(() => {
    if (!current || level === "personal") return;
    const timeout = setTimeout(() => {
      setQueue((pending) => pending[0]?.id === current.id ? pending.slice(1) : pending);
    }, TRANSIENT_DURATION[level ?? "routine"]);
    return () => clearTimeout(timeout);
  }, [current?.id, level]);

  const acknowledgeCurrent = () => {
    if (!current) return;
    setQueue((pending) => pending[0]?.id === current.id ? pending.slice(1) : pending);
  };

  if (!current || !level) return null;

  const personal = level === "personal";
  const routine = level === "routine";
  const eventLimit = personal ? 5 : 4;
  const presentedEvents = getPresentedEffectEvents(current, localPlayerId);
  const privateFacts = getPresentedPrivateFacts(current, localPlayerId);
  const personalEvents = presentedEvents.filter((event) => event.affectsLocalPlayer);
  const otherEvents = presentedEvents.filter((event) => !event.affectsLocalPlayer);
  const visibleEvents = personal
    ? [...personalEvents, ...otherEvents.slice(0, 3)]
    : presentedEvents.slice(0, eventLimit);

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[85] w-[min(92vw,26rem)] pointer-events-none">
      <AnimatePresence mode="wait">
        <motion.section
          key={current.id}
          initial={{ opacity: 0, y: -18, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.98 }}
          transition={{ type: "spring", bounce: 0.2, duration: 0.35 }}
          role="status"
          aria-live={personal ? "assertive" : "polite"}
          className={cn(
            "pointer-events-auto bg-card/97 backdrop-blur-lg border shadow-xl rounded-2xl overflow-hidden",
            personal ? "border-primary/60 ring-2 ring-primary/20" : "border-border",
            routine && "rounded-xl shadow-lg"
          )}
        >
          <div className={cn(
            "flex items-center gap-2 text-primary bg-primary/10 border-b border-border",
            routine ? "px-3 py-1.5" : "px-4 py-2"
          )}>
            <Sparkles className="w-3.5 h-3.5 shrink-0" />
            <div className="min-w-0 flex-1 text-xs font-bold uppercase tracking-widest truncate">
              {getEffectAnnouncementHeading(current, localPlayerId)}
            </div>
          </div>

          <div className={cn("flex gap-3", routine ? "p-2.5" : "p-3")}>
            {!routine && (current.imageKey ? (
              <div className="w-14 h-[5.25rem] rounded-lg overflow-hidden border border-border shrink-0 shadow-sm">
                <img src={assetUrl(current.imageKey)} alt={current.cardName} className="w-full h-full object-cover" />
              </div>
            ) : (
              <div className="w-14 h-[5.25rem] rounded-lg border border-border bg-muted flex items-center justify-center shrink-0 p-1 text-center">
                <span className="text-[9px] font-bold leading-tight">{current.cardName}</span>
              </div>
            ))}
            <div className="flex-1 min-w-0">
              <div className="font-display font-bold text-sm leading-tight text-foreground">
                {routine ? `${current.playedByName} · ${current.cardName}` : current.cardName}
              </div>
              {!routine && current.cardText && (
                <div className="mt-1 text-[11px] leading-snug font-medium bg-yellow-100/80 dark:bg-yellow-900/30 border border-yellow-300/60 text-yellow-900 dark:text-yellow-200 rounded-md px-2 py-1">
                  {current.cardText}
                </div>
              )}
              {personal && (
                <p className="mt-1 text-[11px] font-semibold text-muted-foreground">
                  Because of <span className="text-foreground">{current.cardName}</span>
                </p>
              )}
              {personal && privateFacts.length === 0 && current.privateEvents && current.privateEvents.length > 0 && (
                <ul className="mt-1 space-y-0.5 rounded-md bg-primary/5 px-2 py-1.5 text-[11px] font-medium text-foreground">
                  {current.privateEvents.map((detail, index) => <li key={`private-${index}`}>{detail}</li>)}
                </ul>
              )}
              {visibleEvents.length > 0 ? (
                <div className={cn("space-y-1.5", routine ? "mt-1" : "mt-1.5")}>
                  {personalEvents.length > 0 && (
                    <div>
                      <p className="mb-0.5 text-[9px] font-bold uppercase tracking-wider text-primary">Your outcome</p>
                      <ul className="space-y-1">
                        {personalEvents.map(({ event, text }, index) => {
                          const Icon = EVENT_ICON[event.kind] ?? Info;
                          return (
                            <li key={`personal-${event.kind}-${index}`} className="flex items-start gap-1.5 text-[11px] leading-snug font-medium text-foreground">
                              <Icon className={cn("w-3 h-3 mt-0.5 shrink-0", EVENT_COLOR[event.kind]?.split(" ")[0] ?? "text-muted-foreground")} />
                              <span>{text}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                  {otherEvents.length > 0 && (
                    <div>
                      {personal && <p className="mb-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Other outcomes</p>}
                      <ul className="space-y-1">
                        {(personal ? otherEvents.slice(0, 3) : visibleEvents).map(({ event, text }, index) => {
                          const Icon = EVENT_ICON[event.kind] ?? Info;
                          return (
                            <li key={`other-${event.kind}-${index}`} className={cn(
                              "flex items-start gap-1.5 text-[11px] leading-snug",
                              personal ? "text-muted-foreground" : "text-foreground/85"
                            )}>
                              <Icon className={cn("w-3 h-3 mt-0.5 shrink-0", EVENT_COLOR[event.kind]?.split(" ")[0] ?? "text-muted-foreground")} />
                              <span>{text}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </div>
              ) : current.cardText ? (
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{current.cardText}</p>
              ) : (
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">No additional effect.</p>
              )}
            </div>
          </div>

          {personal && (
            <div className="px-3 pb-3 flex justify-end">
              <button
                type="button"
                onClick={acknowledgeCurrent}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                Got it
              </button>
            </div>
          )}
        </motion.section>
      </AnimatePresence>
    </div>
  );
}