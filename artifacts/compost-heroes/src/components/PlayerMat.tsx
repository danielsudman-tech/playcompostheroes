import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { GameCard } from "./GameCard";
import type { PlayerState, CardState } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { User, ChevronLeft, ChevronRight } from "lucide-react";
import { assetUrl } from "@/lib/assetUrl";

interface PlayerMatProps {
  player: PlayerState;
  isCurrentPlayer: boolean;
  isLocalUser: boolean;
  isActiveTurn: boolean;
  onPlayCard?: (cardId: string) => void;
  onViewPile?: () => void;
  onMoveLayer?: (cardId: string, targetFunction?: string) => void;
  className?: string;
  compact?: boolean;
}

const CATEGORIES = [
  {
    key: "moisture",
    canonicalFn: "Moisture",
    label: "Moisture",
    iconSrc: assetUrl("icon-moisture.png"),
    borderClass: "border-blue-400",
    bgClass: "bg-blue-50 dark:bg-blue-950/30",
    headerClass: "bg-blue-100 text-blue-800",
    emptyDotClass: "bg-blue-200",
    iconClass: "opacity-100",
    match: (fn: string) => fn.toLowerCase().includes("moisture"),
  },
  {
    key: "carbon",
    canonicalFn: "Carbon",
    label: "Carbon",
    iconSrc: assetUrl("icon-carbon.png"),
    borderClass: "border-amber-400",
    bgClass: "bg-amber-50 dark:bg-amber-950/30",
    headerClass: "bg-amber-100 text-amber-800",
    emptyDotClass: "bg-amber-200",
    iconClass: "opacity-100",
    match: (fn: string) => fn.toLowerCase().includes("carbon"),
  },
  {
    key: "decomposer",
    canonicalFn: "Decomposer",
    label: "Decomposer",
    iconSrc: assetUrl("icon-decomposer.png"),
    borderClass: "border-orange-400",
    bgClass: "bg-orange-50 dark:bg-orange-950/30",
    headerClass: "bg-orange-100 text-orange-800",
    emptyDotClass: "bg-orange-200",
    iconClass: "opacity-100",
    match: (fn: string) =>
      fn.toLowerCase().includes("decomp") || fn.toLowerCase().includes("fire"),
  },
  {
    key: "nitrogen",
    canonicalFn: "Nitrogen",
    label: "Nitrogen",
    iconSrc: assetUrl("icon-nitrogen.png"),
    borderClass: "border-lime-400",
    bgClass: "bg-lime-50 dark:bg-lime-950/30",
    headerClass: "bg-lime-100 text-lime-800",
    emptyDotClass: "bg-lime-200",
    iconClass: "opacity-100",
    match: (fn: string) => fn.toLowerCase().includes("nitrogen"),
  },
  {
    key: "airflow",
    canonicalFn: "Airflow",
    label: "Airflow",
    iconSrc: assetUrl("icon-airflow.png"),
    borderClass: "border-cyan-400",
    bgClass: "bg-cyan-50 dark:bg-cyan-950/30",
    headerClass: "bg-cyan-100 text-cyan-800",
    emptyDotClass: "bg-cyan-200",
    iconClass: "opacity-100",
    match: (fn: string) => fn.toLowerCase().includes("air"),
  },
];

function getEffectiveFn(card: CardState): string {
  return (card as any).chosenFunction ?? card.function ?? "";
}

function getCategoryCards(pile: CardState[], matchFn: (fn: string) => boolean) {
  return pile.filter((c) => matchFn(getEffectiveFn(c)));
}

const POPUP_HEIGHT = 320;
const POPUP_GAP = 8;

function HoverableCard({
  card,
  canMove,
  onMoveLayer,
  draggable: isDraggable,
  onDragStart,
  onDragEnd,
}: {
  card: CardState;
  canMove?: boolean;
  onMoveLayer?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [popupPos, setPopupPos] = useState<{ x: number; top: number; bottom: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageSrc = card.imageKey ? assetUrl(card.imageKey) : null;

  const handleMouseEnter = () => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setPopupPos({ x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom });
    }
    setHovered(true);
  };

  const handleMouseLeave = () => {
    setHovered(false);
    setPopupPos(null);
  };

  const showBelow = popupPos ? popupPos.top < POPUP_HEIGHT : false;

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full h-full flex items-center justify-center", isDraggable && "cursor-grab active:cursor-grabbing")}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      draggable={isDraggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      {imageSrc ? (
        <img
          src={imageSrc}
          alt={card.name}
          className="w-full h-full object-cover rounded-lg"
          style={{ display: "block" }}
          draggable={false}
        />
      ) : (
        <GameCard card={card} size="xs" hoverable={false} />
      )}

      {canMove && onMoveLayer && (
        <button
          onClick={(e) => { e.stopPropagation(); onMoveLayer(); }}
          className="absolute -bottom-1 -right-1 z-10 bg-primary text-white rounded-full p-0.5 shadow-md hover:bg-primary/80 transition-colors"
          title="Move to another slot"
        >
          <ChevronRight className="w-2.5 h-2.5" />
        </button>
      )}

      {hovered && popupPos && createPortal(
        <div
          className="pointer-events-none"
          style={{
            position: "fixed",
            left: popupPos.x,
            transform: "translateX(-50%)",
            zIndex: 99999,
            ...(showBelow
              ? { top: popupPos.bottom + POPUP_GAP }
              : { bottom: window.innerHeight - popupPos.top + POPUP_GAP }),
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ duration: 0.15 }}
            style={{ transformOrigin: showBelow ? "top center" : "bottom center" }}
          >
            <div className="shadow-2xl rounded-xl overflow-hidden border-2 border-white/40">
              {imageSrc ? (
                <img src={imageSrc} alt={card.name} className="w-56 h-80 object-contain bg-card" />
              ) : (
                <GameCard card={card} size="md" hoverable={false} />
              )}
            </div>
          </motion.div>
        </div>,
        document.body
      )}
    </div>
  );
}

export function PlayerMat({
  player,
  isCurrentPlayer,
  isLocalUser,
  isActiveTurn,
  onViewPile,
  onMoveLayer,
  className,
  compact = false,
}: PlayerMatProps) {
  const collectedCount = CATEGORIES.filter(
    (cat) => getCategoryCards(player.compostPile, cat.match).length > 0
  ).length;

  const [slotActiveIdx, setSlotActiveIdx] = useState<Record<string, number>>({});

  // Drag-and-drop state (full view only)
  const [draggedCardId, setDraggedCardId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

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

        {/* Compact compost pile — 5 slots with card count badges */}
        <div className="grid grid-cols-5 gap-1 mb-2">
          {CATEGORIES.map((cat) => {
            const cards = getCategoryCards(player.compostPile, cat.match);
            const topCard = cards[cards.length - 1] ?? null;
            const has = topCard !== null;
            const count = cards.length;
            return (
              <div
                key={cat.key}
                className={cn(
                  "rounded-lg border-2 overflow-visible flex flex-col items-center transition-all relative",
                  has
                    ? cat.borderClass + " " + cat.bgClass
                    : "border-muted/40 bg-muted/20"
                )}
                style={{ minHeight: 52 }}
              >
                {/* Category icon */}
                <div className={cn("pt-0.5 pb-0.5", !has && "opacity-20")}>
                  <img src={cat.iconSrc} alt={cat.label} className="w-2.5 h-2.5 object-contain" draggable={false} />
                </div>
                {/* Card slot */}
                <div className="w-full flex-1 px-0.5 pb-0.5 relative" style={{ minHeight: 36 }}>
                  {has ? (
                    <HoverableCard card={topCard!} />
                  ) : (
                    <div className="w-full h-full rounded flex items-center justify-center">
                      <div className={cn("w-2 h-2 rounded-full", cat.emptyDotClass)} />
                    </div>
                  )}
                  {/* Count badge */}
                  {count > 1 && (
                    <div className="absolute -top-1.5 -right-1.5 z-10 w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center shadow-md border border-white">
                      {count}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Face-down hand cards — vertical stack */}
        <div className="flex items-start gap-2 mt-1">
          <span className="text-[10px] text-muted-foreground font-bold uppercase mt-0.5 shrink-0">Hand:</span>
          <div className="flex flex-col gap-0.5">
            {Array.from({ length: player.hand.length }).map((_, i) => (
              <div
                key={i}
                className="w-7 h-4 rounded border border-border bg-secondary/60 shadow-sm"
                style={{
                  backgroundImage: `url('${assetUrl("card-back.jpg")}')`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              />
            ))}
            {player.hand.length === 0 && (
              <span className="text-[10px] text-muted-foreground/50 italic">Empty</span>
            )}
          </div>
          {player.hand.length > 0 && (
            <span className="text-[10px] text-muted-foreground/60 mt-0.5">{player.hand.length} card{player.hand.length !== 1 ? "s" : ""}</span>
          )}
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

  // Full PlayerMat (local player — desktop)
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

      {/* COMPOST PILE: 5 Category Slots with drag-and-drop */}
      <div className="px-4 pb-3">
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-2">
          Compost Pile
          {isLocalUser && isActiveTurn && (
            <span className="text-[9px] text-muted-foreground/50 normal-case font-normal">— drag a hero to move it</span>
          )}
        </div>
        <div className="grid grid-cols-5 gap-2">
          {CATEGORIES.map((cat) => {
            const cards = getCategoryCards(player.compostPile, cat.match);
            const activeIdx = Math.min(slotActiveIdx[cat.key] ?? 0, Math.max(0, cards.length - 1));
            const activeCard = cards[activeIdx] ?? null;
            const has = cards.length > 0;
            const multi = cards.length > 1;

            // Determine if this slot is a valid drop target for the dragged card
            const draggedCard = draggedCardId ? player.compostPile.find(c => c.id === draggedCardId) : null;
            const draggedCurrentFn = draggedCard ? getEffectiveFn(draggedCard) : null;
            const isCurrentSlot = draggedCard ? cat.match(draggedCurrentFn ?? "") : false;
            // Any empty slot (other than the card's current slot) is a valid rearrangement target
            const isValidDropTarget = draggedCard && !isCurrentSlot && !has;
            const isDragOver = dragOverKey === cat.key && isValidDropTarget;

            const goNext = (e: React.MouseEvent) => {
              e.stopPropagation();
              setSlotActiveIdx(prev => ({ ...prev, [cat.key]: (activeIdx + 1) % cards.length }));
            };
            const goPrev = (e: React.MouseEvent) => {
              e.stopPropagation();
              setSlotActiveIdx(prev => ({ ...prev, [cat.key]: (activeIdx - 1 + cards.length) % cards.length }));
            };

            return (
              <div
                key={cat.key}
                className={cn(
                  "rounded-xl border-2 flex flex-col items-center transition-all duration-200 overflow-visible",
                  has
                    ? cat.borderClass + " " + cat.bgClass
                    : "border-dashed border-muted-foreground/20 bg-muted/10",
                  isDragOver && "ring-2 ring-primary ring-offset-1 border-primary/60 bg-primary/5 scale-105",
                  draggedCardId && isValidDropTarget && !isDragOver && "border-primary/30 bg-primary/5 opacity-80",
                  draggedCardId && !isValidDropTarget && !isCurrentSlot && "opacity-30",
                )}
                onDragOver={(e) => {
                  if (isValidDropTarget) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDragOverKey(cat.key);
                  }
                }}
                onDragLeave={() => setDragOverKey(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverKey(null);
                  if (draggedCardId && isValidDropTarget && onMoveLayer) {
                    onMoveLayer(draggedCardId, cat.canonicalFn);
                  }
                  setDraggedCardId(null);
                }}
              >
                {/* Slot header */}
                <div
                  className={cn(
                    "flex items-center gap-0.5 w-full px-1 py-1 text-[9px] font-bold uppercase tracking-wider rounded-t-lg border-b",
                    has
                      ? cat.headerClass + " border-current/20"
                      : "bg-transparent text-muted-foreground/40 border-transparent"
                  )}
                >
                  <img src={cat.iconSrc} alt={cat.label} className="w-2.5 h-2.5 shrink-0 object-contain" draggable={false} />
                  <span className="truncate">{cat.label}</span>
                  {multi && (
                    <span className="ml-auto font-bold text-[8px]">{activeIdx + 1}/{cards.length}</span>
                  )}
                  {/* Count badge on header for multi-card slots */}
                  {multi && (
                    <span className="ml-1 bg-primary text-primary-foreground rounded-full w-3.5 h-3.5 flex items-center justify-center text-[8px] font-bold">
                      {cards.length}
                    </span>
                  )}
                </div>

                {/* Drop zone indicator */}
                {isDragOver && (
                  <div className="absolute inset-0 rounded-xl flex items-center justify-center pointer-events-none z-10">
                    <div className="text-primary font-bold text-[10px] bg-primary/10 px-1.5 py-0.5 rounded-lg">Drop here</div>
                  </div>
                )}

                {/* Card display — navigable when multiple */}
                <div className="relative w-full h-40" style={{ minHeight: 96 }}>
                  <AnimatePresence mode="wait">
                    {activeCard ? (
                      <motion.div
                        key={activeCard.id}
                        initial={{ scale: 0.85, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.85, opacity: 0 }}
                        transition={{ type: "spring", duration: 0.25 }}
                        className="absolute inset-0.5"
                      >
                        <HoverableCard
                          card={activeCard}
                          canMove={isActiveTurn && isLocalUser && (activeCard as any).type === "hero"}
                          onMoveLayer={onMoveLayer ? () => onMoveLayer(activeCard.id) : undefined}
                          draggable={isActiveTurn && isLocalUser && (activeCard as any).type === "hero"}
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = "move";
                            setDraggedCardId(activeCard.id);
                          }}
                          onDragEnd={() => {
                            setDraggedCardId(null);
                            setDragOverKey(null);
                          }}
                        />
                      </motion.div>
                    ) : (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground/25">
                        <img src={cat.iconSrc} alt={cat.label} className="w-6 h-6 object-contain opacity-25" draggable={false} />
                        <span className="text-[8px] font-bold uppercase">Empty</span>
                      </div>
                    )}
                  </AnimatePresence>

                  {/* Navigation arrows — only when multiple cards */}
                  {multi && (
                    <>
                      <button
                        onClick={goPrev}
                        className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 z-20 w-5 h-5 bg-card/90 border border-border rounded-full flex items-center justify-center shadow-md hover:bg-primary hover:text-primary-foreground transition-colors"
                      >
                        <ChevronLeft className="w-3 h-3" />
                      </button>
                      <button
                        onClick={goNext}
                        className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 z-20 w-5 h-5 bg-card/90 border border-border rounded-full flex items-center justify-center shadow-md hover:bg-primary hover:text-primary-foreground transition-colors"
                      >
                        <ChevronRight className="w-3 h-3" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
