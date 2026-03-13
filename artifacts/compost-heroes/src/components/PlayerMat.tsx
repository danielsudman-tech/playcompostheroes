import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { GameCard } from "./GameCard";
import type { PlayerState, CardState } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { Wind, Leaf, Droplets, Sprout, Worm, User } from "lucide-react";

interface PlayerMatProps {
  player: PlayerState;
  isCurrentPlayer: boolean;
  isLocalUser: boolean;
  isActiveTurn: boolean;
  onPlayCard?: (cardId: string) => void;
  onViewPile?: () => void;
  className?: string;
  compact?: boolean;
}

const CATEGORIES = [
  {
    key: "airflow",
    label: "Airflow",
    Icon: Wind,
    borderClass: "border-cyan-400",
    bgClass: "bg-cyan-50 dark:bg-cyan-950/30",
    headerClass: "bg-cyan-100 text-cyan-800",
    emptyDotClass: "bg-cyan-200",
    iconClass: "text-cyan-500",
    match: (fn: string) => fn.toLowerCase().includes("air"),
  },
  {
    key: "carbon",
    label: "Carbon",
    Icon: Leaf,
    borderClass: "border-amber-400",
    bgClass: "bg-amber-50 dark:bg-amber-950/30",
    headerClass: "bg-amber-100 text-amber-800",
    emptyDotClass: "bg-amber-200",
    iconClass: "text-amber-500",
    match: (fn: string) => fn.toLowerCase().includes("carbon"),
  },
  {
    key: "moisture",
    label: "Moisture",
    Icon: Droplets,
    borderClass: "border-blue-400",
    bgClass: "bg-blue-50 dark:bg-blue-950/30",
    headerClass: "bg-blue-100 text-blue-800",
    emptyDotClass: "bg-blue-200",
    iconClass: "text-blue-500",
    match: (fn: string) => fn.toLowerCase().includes("moisture"),
  },
  {
    key: "nitrogen",
    label: "Nitrogen",
    Icon: Sprout,
    borderClass: "border-lime-400",
    bgClass: "bg-lime-50 dark:bg-lime-950/30",
    headerClass: "bg-lime-100 text-lime-800",
    emptyDotClass: "bg-lime-200",
    iconClass: "text-lime-600",
    match: (fn: string) => fn.toLowerCase().includes("nitrogen"),
  },
  {
    key: "decomposer",
    label: "Decomposer",
    Icon: Worm,
    borderClass: "border-orange-400",
    bgClass: "bg-orange-50 dark:bg-orange-950/30",
    headerClass: "bg-orange-100 text-orange-800",
    emptyDotClass: "bg-orange-200",
    iconClass: "text-orange-500",
    match: (fn: string) =>
      fn.toLowerCase().includes("decomp") || fn.toLowerCase().includes("fire"),
  },
];

function getCategoryCards(pile: CardState[], matchFn: (fn: string) => boolean) {
  return pile.filter((c) => matchFn(c.function || ""));
}

const BASE = import.meta.env.BASE_URL as string;

function HoverableCard({ card }: { card: CardState }) {
  const [hovered, setHovered] = useState(false);
  const imageSrc = card.imageKey ? `${BASE}assets/${card.imageKey}` : null;

  return (
    <div
      className="relative flex items-center justify-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {imageSrc ? (
        <img
          src={imageSrc}
          alt={card.name}
          className="w-full h-full object-cover rounded-lg"
          style={{ display: "block" }}
        />
      ) : (
        <GameCard card={card} size="xs" hoverable={false} />
      )}

      <AnimatePresence>
        {hovered && (
          <motion.div
            initial={{ opacity: 0, scale: 0.7, y: 0 }}
            animate={{ opacity: 1, scale: 1, y: -20 }}
            exit={{ opacity: 0, scale: 0.7, y: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none"
            style={{ transformOrigin: "bottom center" }}
          >
            <div className="shadow-2xl rounded-xl overflow-hidden border-2 border-white/40">
              {imageSrc ? (
                <img
                  src={imageSrc}
                  alt={card.name}
                  className="w-40 h-56 object-cover"
                />
              ) : (
                <GameCard card={card} size="md" hoverable={false} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function PlayerMat({
  player,
  isCurrentPlayer,
  isLocalUser,
  isActiveTurn,
  onViewPile,
  className,
  compact = false,
}: PlayerMatProps) {
  const collectedCount = CATEGORIES.filter(
    (cat) => getCategoryCards(player.compostPile, cat.match).length > 0
  ).length;

  if (compact) {
    return (
      <div
        className={cn(
          "bg-card rounded-2xl p-3 border-2 shadow-sm transition-all relative overflow-hidden",
          isActiveTurn
            ? "border-primary shadow-primary/20 scale-[1.02]"
            : "border-transparent",
          className
        )}
      >
        {isActiveTurn && (
          <div className="absolute top-0 left-0 w-full h-1 bg-primary animate-pulse" />
        )}

        <div className="flex justify-between items-center mb-2">
          <h3 className="font-display font-bold text-base text-foreground flex items-center gap-1.5">
            <User className="w-4 h-4 text-primary" />
            {player.name}
            {isActiveTurn && (
              <span className="text-[10px] text-primary font-bold uppercase tracking-wider animate-pulse ml-1">
                Turn
              </span>
            )}
          </h3>
        </div>

        {/* Compact compost pile — 5 slots with tiny card images */}
        <div className="grid grid-cols-5 gap-1 mb-2">
          {CATEGORIES.map((cat) => {
            const cards = getCategoryCards(player.compostPile, cat.match);
            const topCard = cards[cards.length - 1] ?? null;
            const has = topCard !== null;
            return (
              <div
                key={cat.key}
                className={cn(
                  "rounded-lg border-2 overflow-visible flex flex-col items-center transition-all",
                  has
                    ? cat.borderClass + " " + cat.bgClass
                    : "border-muted/40 bg-muted/20"
                )}
                style={{ minHeight: 52 }}
              >
                {/* Category icon */}
                <div className={cn("pt-0.5 pb-0.5", has ? cat.iconClass : "text-muted-foreground/30")}>
                  <cat.Icon className="w-2.5 h-2.5" />
                </div>
                {/* Tiny card slot */}
                <div className="w-full flex-1 px-0.5 pb-0.5 relative" style={{ minHeight: 36 }}>
                  {has ? (
                    <HoverableCard card={topCard!} />
                  ) : (
                    <div className="w-full h-full rounded flex items-center justify-center">
                      <div className={cn("w-2 h-2 rounded-full", cat.emptyDotClass)} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Face-down hand cards */}
        <div className="flex items-center gap-1 mt-1">
          <span className="text-[10px] text-muted-foreground font-bold uppercase mr-1">Hand:</span>
          <div className="flex gap-0.5">
            {Array.from({ length: player.hand.length }).map((_, i) => (
              <div
                key={i}
                className="w-5 h-7 rounded border border-border bg-secondary/60 shadow-sm"
                style={{
                  backgroundImage: `url('${BASE}assets/card_back.jpg')`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              />
            ))}
            {player.hand.length === 0 && (
              <span className="text-[10px] text-muted-foreground/50 italic">Empty</span>
            )}
          </div>
        </div>

        {player.compostPile.length > 0 && (
          <button
            onClick={onViewPile}
            className="mt-1.5 w-full text-[10px] font-bold text-primary hover:text-primary/80 transition-colors py-0.5 rounded-lg hover:bg-primary/5 border border-primary/20 hover:border-primary/40"
          >
            View Full Pile ({player.compostPile.length})
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex flex-col bg-card/90 backdrop-blur-md rounded-t-3xl border-t border-x shadow-2xl",
        isActiveTurn ? "border-primary/40" : "border-border",
        className
      )}
    >
      {isActiveTurn && (
        <div className="absolute top-0 left-0 w-full h-1 bg-primary rounded-t-3xl" />
      )}

      {/* Mat Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "w-10 h-10 rounded-full flex items-center justify-center font-display text-white font-bold text-lg shadow-md",
              isActiveTurn ? "bg-primary animate-pulse" : "bg-muted-foreground"
            )}
          >
            {player.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <h2 className="font-display font-bold text-xl text-foreground leading-tight">
              {player.name}{" "}
              {isLocalUser ? (
                <span className="text-sm text-primary font-normal">(You)</span>
              ) : (
                ""
              )}
            </h2>
            {isActiveTurn && (
              <span className="text-xs font-bold text-primary uppercase tracking-wider animate-pulse">
                Your Turn
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm font-bold text-muted-foreground">
          <span className="bg-muted/50 px-3 py-1 rounded-xl border">
            {collectedCount}/5 heroes
          </span>
          {player.skipsNextTurn && (
            <span className="text-destructive">⚠️ Skip</span>
          )}
        </div>
      </div>

      {/* COMPOST PILE: 5 Category Slots — image only, hover to enlarge */}
      <div className="px-4 pb-3">
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
          Compost Pile
        </div>
        <div className="grid grid-cols-5 gap-2">
          {CATEGORIES.map((cat) => {
            const cards = getCategoryCards(player.compostPile, cat.match);
            const topCard = cards[cards.length - 1] ?? null;
            const has = topCard !== null;

            return (
              <div
                key={cat.key}
                className={cn(
                  "rounded-xl border-2 flex flex-col items-center transition-all duration-300 overflow-visible",
                  has
                    ? cat.borderClass + " " + cat.bgClass
                    : "border-dashed border-muted-foreground/20 bg-muted/10"
                )}
              >
                {/* Slim category label */}
                <div
                  className={cn(
                    "flex items-center gap-1 w-full px-1.5 py-1 text-[9px] font-bold uppercase tracking-wider rounded-t-lg border-b",
                    has
                      ? cat.headerClass + " border-current/20"
                      : "bg-transparent text-muted-foreground/40 border-transparent"
                  )}
                >
                  <cat.Icon className="w-2.5 h-2.5 shrink-0" />
                  <span className="truncate">{cat.label}</span>
                  {cards.length > 1 && (
                    <span className="ml-auto font-bold">×{cards.length}</span>
                  )}
                </div>

                {/* Card image area — hover to enlarge */}
                <div className="relative w-full" style={{ height: 90 }}>
                  <AnimatePresence>
                    {topCard ? (
                      <motion.div
                        key={topCard.id}
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: "spring", duration: 0.3 }}
                        className="absolute inset-1"
                      >
                        <HoverableCard card={topCard} />
                      </motion.div>
                    ) : (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground/25">
                        <cat.Icon className="w-6 h-6" />
                        <span className="text-[8px] font-bold uppercase">
                          Empty
                        </span>
                      </div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
