import { motion, AnimatePresence } from "framer-motion";
import { GameCard } from "./GameCard";
import type { PlayerState, CardState } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { Wind, Leaf, Droplets, Sprout, Worm, Hand, User, CheckCircle2 } from "lucide-react";

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
    bgClass: "bg-cyan-50 border-cyan-300",
    headerClass: "bg-cyan-100 text-cyan-800 border-cyan-300",
    filledClass: "bg-cyan-100",
    dotClass: "bg-cyan-500",
    checkClass: "text-cyan-600",
    match: (fn: string) => fn.toLowerCase().includes("air"),
  },
  {
    key: "carbon",
    label: "Carbon",
    Icon: Leaf,
    bgClass: "bg-amber-50 border-amber-300",
    headerClass: "bg-amber-100 text-amber-800 border-amber-300",
    filledClass: "bg-amber-100",
    dotClass: "bg-amber-500",
    checkClass: "text-amber-600",
    match: (fn: string) => fn.toLowerCase().includes("carbon"),
  },
  {
    key: "moisture",
    label: "Moisture",
    Icon: Droplets,
    bgClass: "bg-blue-50 border-blue-300",
    headerClass: "bg-blue-100 text-blue-800 border-blue-300",
    filledClass: "bg-blue-100",
    dotClass: "bg-blue-500",
    checkClass: "text-blue-600",
    match: (fn: string) => fn.toLowerCase().includes("moisture"),
  },
  {
    key: "nitrogen",
    label: "Nitrogen",
    Icon: Sprout,
    bgClass: "bg-lime-50 border-lime-300",
    headerClass: "bg-lime-100 text-lime-800 border-lime-300",
    filledClass: "bg-lime-100",
    dotClass: "bg-lime-500",
    checkClass: "text-lime-600",
    match: (fn: string) => fn.toLowerCase().includes("nitrogen"),
  },
  {
    key: "decomposer",
    label: "Decomposer",
    Icon: Worm,
    bgClass: "bg-orange-50 border-orange-300",
    headerClass: "bg-orange-100 text-orange-800 border-orange-300",
    filledClass: "bg-orange-100",
    dotClass: "bg-orange-500",
    checkClass: "text-orange-600",
    match: (fn: string) => fn.toLowerCase().includes("decomp") || fn.toLowerCase().includes("fire"),
  },
];

function getCategoryCards(pile: CardState[], matchFn: (fn: string) => boolean) {
  return pile.filter(c => matchFn(c.function || ""));
}

export function PlayerMat({
  player,
  isCurrentPlayer,
  isLocalUser,
  isActiveTurn,
  onPlayCard,
  onViewPile,
  className,
  compact = false,
}: PlayerMatProps) {
  const collectedCount = CATEGORIES.filter(cat =>
    getCategoryCards(player.compostPile, cat.match).length > 0
  ).length;

  if (compact) {
    return (
      <div className={cn(
        "bg-card rounded-2xl p-3 border-2 shadow-sm transition-all relative overflow-hidden",
        isActiveTurn ? "border-primary shadow-primary/20 scale-[1.02]" : "border-transparent",
        className
      )}>
        {isActiveTurn && <div className="absolute top-0 left-0 w-full h-1 bg-primary animate-pulse" />}

        <div className="flex justify-between items-center mb-2">
          <h3 className="font-display font-bold text-base text-foreground flex items-center gap-1.5">
            <User className="w-4 h-4 text-primary" />
            {player.name}
          </h3>
          <div className="flex items-center gap-1 bg-muted/50 px-2 py-1 rounded-full text-xs font-bold text-muted-foreground">
            <Hand className="w-3 h-3" />
            {player.hand.length}
          </div>
        </div>

        {/* Compact 5-slot grid */}
        <div className="grid grid-cols-5 gap-1">
          {CATEGORIES.map(cat => {
            const cards = getCategoryCards(player.compostPile, cat.match);
            const has = cards.length > 0;
            return (
              <div key={cat.key} className={cn(
                "rounded-lg border flex flex-col items-center py-1.5 transition-all",
                has ? cat.filledClass + " border-opacity-100" : "bg-muted/30 border-muted/40"
              )}>
                <cat.Icon className={cn("w-3 h-3 mb-0.5", has ? cat.checkClass : "text-muted-foreground/40")} />
                <span className={cn("text-[8px] font-bold uppercase leading-tight text-center", has ? cat.checkClass : "text-muted-foreground/40")}>
                  {cat.label.substring(0, 4)}
                </span>
                {has && <div className={cn("w-1.5 h-1.5 rounded-full mt-0.5", cat.dotClass)} />}
              </div>
            );
          })}
        </div>

        <button
          onClick={onViewPile}
          className="mt-2 w-full text-[10px] font-bold text-primary hover:text-primary/80 transition-colors py-1 rounded-lg hover:bg-primary/5 border border-primary/20 hover:border-primary/40"
        >
          View Pile ({player.compostPile.length} cards)
        </button>
      </div>
    );
  }

  // Full Player Mat — matches the physical game mat layout
  return (
    <div className={cn(
      "relative flex flex-col bg-card/90 backdrop-blur-md rounded-t-3xl border-t border-x shadow-2xl",
      isActiveTurn ? "border-primary/40" : "border-border",
      className
    )}>
      {isActiveTurn && <div className="absolute top-0 left-0 w-full h-1 bg-primary rounded-t-3xl" />}

      {/* Mat Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-10 h-10 rounded-full flex items-center justify-center font-display text-white font-bold text-lg shadow-md",
            isActiveTurn ? "bg-primary animate-pulse" : "bg-muted-foreground"
          )}>
            {player.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <h2 className="font-display font-bold text-xl text-foreground leading-tight">
              {player.name} {isLocalUser ? <span className="text-sm text-primary font-normal">(You)</span> : ""}
            </h2>
            {isActiveTurn && (
              <span className="text-xs font-bold text-primary uppercase tracking-wider animate-pulse">Your Turn</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 bg-muted/50 px-3 py-1.5 rounded-xl border text-sm font-bold text-muted-foreground">
          <Hand className="w-4 h-4" />
          {player.hand.length}/{player.maxHandSize} cards
          {player.skipsNextTurn && <span className="text-destructive ml-1">⚠️ Skip</span>}
        </div>
      </div>

      {/* THE COMPOST MAT: 5 Category Slots */}
      <div className="px-4 pb-2">
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2 flex items-center justify-between">
          <span>Compost Pile — {collectedCount}/5 Categories</span>
          <span className="text-primary">{collectedCount === 5 ? "🎉 Complete!" : `${5 - collectedCount} more needed`}</span>
        </div>
        <div className="grid grid-cols-5 gap-2">
          {CATEGORIES.map(cat => {
            const cards = getCategoryCards(player.compostPile, cat.match);
            const topCard = cards[cards.length - 1] ?? null;
            const has = cards.length > 0;

            return (
              <div key={cat.key} className={cn(
                "rounded-xl border-2 overflow-hidden flex flex-col transition-all duration-300",
                has ? cat.bgClass + " shadow-sm" : "bg-muted/20 border-dashed border-muted-foreground/20"
              )}>
                {/* Slot header */}
                <div className={cn(
                  "flex items-center gap-1 px-2 py-1.5 border-b text-[10px] font-bold uppercase tracking-widest",
                  has ? cat.headerClass : "bg-muted/30 text-muted-foreground/50 border-muted-foreground/10"
                )}>
                  <cat.Icon className="w-3 h-3 shrink-0" />
                  <span className="truncate">{cat.label}</span>
                  {has && <CheckCircle2 className={cn("w-3 h-3 ml-auto shrink-0", cat.checkClass)} />}
                </div>

                {/* Card slot */}
                <div className="flex-1 flex items-center justify-center p-1.5 min-h-[90px] relative">
                  <AnimatePresence>
                    {topCard ? (
                      <motion.div
                        key={topCard.id}
                        initial={{ scale: 0.7, opacity: 0, y: -10 }}
                        animate={{ scale: 1, opacity: 1, y: 0 }}
                        transition={{ type: "spring", duration: 0.4 }}
                        className="relative"
                      >
                        <GameCard card={topCard} size="xs" />
                        {cards.length > 1 && (
                          <div className="absolute -top-1 -right-1 w-4 h-4 bg-primary text-primary-foreground rounded-full text-[9px] font-bold flex items-center justify-center shadow">
                            {cards.length}
                          </div>
                        )}
                      </motion.div>
                    ) : (
                      <div className="w-full h-full min-h-[80px] flex flex-col items-center justify-center text-muted-foreground/30 gap-1">
                        <cat.Icon className="w-5 h-5" />
                        <span className="text-[9px] font-bold uppercase">Empty</span>
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
