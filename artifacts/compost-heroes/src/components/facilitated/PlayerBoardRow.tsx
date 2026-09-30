import type { PlayerState, ActiveModifier, Card } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { assetUrl } from "@/lib/assetUrl";
import { GameCard } from "@/components/GameCard";
import { Crosshair, AlertTriangle, Sparkles, User, Layers, ZoomIn, ArrowLeftRight } from "lucide-react";

export const PILE_CATEGORIES = [
  { key: "moisture",   label: "Moisture",   iconSrc: assetUrl("icon-moisture.png"),   color: "text-blue-500",   border: "border-blue-500/30",   bg: "bg-blue-500/10",   match: (fn: string) => fn.toLowerCase().includes("moisture") },
  { key: "carbon",     label: "Carbon",     iconSrc: assetUrl("icon-carbon.png"),     color: "text-amber-500",  border: "border-amber-500/30",  bg: "bg-amber-500/10",  match: (fn: string) => fn.toLowerCase().includes("carbon") },
  { key: "decomposer", label: "Decomposer", iconSrc: assetUrl("icon-decomposer.png"), color: "text-orange-500", border: "border-orange-500/30", bg: "bg-orange-500/10", match: (fn: string) => fn.toLowerCase().includes("decomp") || fn.toLowerCase().includes("fire") },
  { key: "nitrogen",   label: "Nitrogen",   iconSrc: assetUrl("icon-nitrogen.png"),   color: "text-lime-500",   border: "border-lime-500/30",   bg: "bg-lime-500/10",   match: (fn: string) => fn.toLowerCase().includes("nitrogen") },
  { key: "airflow",    label: "Airflow",    iconSrc: assetUrl("icon-airflow.png"),    color: "text-cyan-500",   border: "border-cyan-500/30",   bg: "bg-cyan-500/10",   match: (fn: string) => fn.toLowerCase().includes("air") },
];

export function getEffectiveFn(card: Card): string {
  return (card as any).chosenFunction ?? card.function ?? "";
}

export function collectedCategoryCount(pile: Card[]): number {
  return PILE_CATEGORIES.filter((cat) => pile.some((c) => c != null && cat.match(getEffectiveFn(c)))).length;
}

/** Returns true if this card can be moved to a different layer slot right now. */
function isMovable(card: Card, pile: Card[]): boolean {
  const validFns: string[] = (card as any).alternateFunctions ?? [];
  if (validFns.length <= 1) return false;
  const occupiedFns = new Set(pile.filter(c => c.id !== card.id).map(c => getEffectiveFn(c)));
  const currentFn = getEffectiveFn(card);
  return validFns.some(fn => fn !== currentFn && !occupiedFns.has(fn));
}

interface PlayerBoardRowProps {
  player: PlayerState;
  isMe: boolean;
  showHandBacks?: boolean;
  isTurn: boolean;
  modifiers: ActiveModifier[];
  targetingActive: boolean;
  isEligibleTarget: boolean;
  onTarget: () => void;
  onViewPile: () => void;
  onZoomCard?: (card: Card) => void;
  /** When provided, movable cards show a "move layer" button. Only pass for own row on own turn. */
  onMoveLayer?: (cardId: string) => void;
}

export function PlayerBoardRow({
  player,
  isMe,
  showHandBacks = false,
  isTurn,
  modifiers,
  targetingActive,
  isEligibleTarget,
  onTarget,
  onViewPile,
  onZoomCard,
  onMoveLayer,
}: PlayerBoardRowProps) {
  const collected = collectedCategoryCount(player.compostPile);
  const oneAway = collected === 4;
  const dimmed = targetingActive && !isEligibleTarget;

  return (
    <div
      onClick={targetingActive ? onTarget : onViewPile}
      className={cn(
        "flex gap-[var(--board-gap)] px-2 py-1.5 rounded-2xl border-2 transition-all group relative",
        targetingActive && isEligibleTarget ? "border-destructive/60 bg-destructive/10 shadow-[0_0_20px_rgba(239,68,68,0.15)] animate-pulse cursor-pointer" : "border-transparent",
        dimmed ? "opacity-35 grayscale-[50%] pointer-events-none" : "",
        !targetingActive && "hover:bg-card/40 cursor-pointer hover:border-primary/20 hover:shadow-lg"
      )}
    >
      {/* Player Info Cell */}
      <div className={cn(
        "w-[var(--board-info)] shrink-0 rounded-xl p-2 lg:p-2.5 border-2 flex flex-col gap-1.5 relative transition-colors bg-card/80 backdrop-blur-sm",
        isTurn ? "border-primary shadow-md shadow-primary/20" : "border-border/50",
        isMe ? "bg-primary/5" : ""
      )}>
        {isTurn && (
          <div className="absolute -top-2.5 -left-2 text-[10px] font-bold uppercase tracking-wider bg-primary text-primary-foreground rounded-full px-2 py-0.5 shadow-sm z-10">
            Current Turn
          </div>
        )}
        {targetingActive && isEligibleTarget && (
          <div className="absolute -top-2.5 -right-2 text-[10px] font-bold uppercase tracking-wider bg-destructive text-destructive-foreground rounded-full px-2 py-0.5 shadow-sm flex items-center gap-1 z-10">
            <Crosshair className="w-3 h-3" /> Pick
          </div>
        )}

        <div className="flex items-start justify-between gap-2 mt-1">
          <div className="flex flex-col min-w-0">
            <span className="font-display font-bold text-sm xl:text-lg leading-tight truncate">{player.name}</span>
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1 mt-0.5">
              {isMe ? <><User className="w-3 h-3" /> You</> : "Opponent"}
            </span>
          </div>
          <div className={cn(
            "shrink-0 flex flex-col items-center justify-center w-8 h-8 xl:w-10 xl:h-10 rounded-full border-2",
            oneAway ? "border-red-400 bg-red-100 text-red-700" : "border-primary/30 bg-primary/10 text-primary"
          )}>
            <span className="text-sm font-black leading-none">{collected}</span>
            <span className="text-[8px] font-bold leading-none mt-0.5">/ 5</span>
          </div>
        </div>

        <div className="mt-auto pt-2 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
            <Layers className="w-3.5 h-3.5" /> {player.hand.length} cards in hand
          </div>
          {showHandBacks && player.hand.length > 0 && (
            <div className="flex items-center pl-0.5" aria-label={`${player.hand.length} hidden cards`}>
              {Array.from({ length: Math.min(player.hand.length, 4) }).map((_, index) => (
                <GameCard
                  key={index}
                  card={{ id: "back", name: "Card Back", type: "unknown", layer: null, effectType: "instant", cardText: "", factText: "", function: "", imageKey: "card-back.jpg" } as any}
                  isFaceDown
                  hoverable={false}
                  className={cn("!w-5 !h-7 !rounded-sm !border", index > 0 && "-ml-3")}
                />
              ))}
            </div>
          )}
          {(player.skipsNextTurn || modifiers.length > 0) && (
             <div className="flex flex-wrap gap-1">
               {player.skipsNextTurn && (
                 <span className="inline-flex items-center gap-1 text-[9px] font-bold text-destructive bg-destructive/10 rounded px-1.5 py-0.5">
                   <AlertTriangle className="w-3 h-3" /> Skips turn
                 </span>
               )}
               {modifiers.map((m, i) => (
                 <span key={i} title={m.effect} className="inline-flex items-center gap-1 text-[9px] font-bold text-primary bg-primary/10 rounded px-1.5 py-0.5 truncate max-w-[140px]">
                   <Sparkles className="w-3 h-3 shrink-0" /> <span className="truncate">{m.cardName}</span>
                 </span>
               ))}
             </div>
          )}
        </div>
      </div>

      {/* Matrix Slots */}
      {PILE_CATEGORIES.map(cat => {
        const cards = player.compostPile.filter(c => c != null && cat.match(getEffectiveFn(c)));
        const has = cards.length > 0;
        const topCard = cards[cards.length - 1];
        const canMove = onMoveLayer && topCard && isMovable(topCard, player.compostPile);

        return (
          <div
            key={cat.key}
            className="w-[var(--board-card-w)] h-[var(--board-card-h)] shrink-0 relative flex items-center justify-center"
            onClick={!targetingActive && has && onZoomCard ? (e) => { e.stopPropagation(); onZoomCard(topCard); } : undefined}
          >
             {!has ? (
               <div className={cn("w-full h-full rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 opacity-60 transition-colors group-hover:border-solid", cat.border, cat.bg)}>
                 <img src={cat.iconSrc} alt={cat.label} className="w-7 h-7 opacity-30 grayscale mix-blend-luminosity" draggable={false} />
                 <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Empty</span>
               </div>
             ) : (
                <div className={cn("relative w-full h-full", !targetingActive && onZoomCard && "cursor-zoom-in")}>
                 {cards.map((c, idx) => (
                   <div
                     key={c.id}
                     className="absolute top-0 left-0 transition-transform duration-300 shadow-sm"
                     style={{
                       transform: `translate(${Math.min(idx, 3) * 5}px, ${Math.min(idx, 3) * 5}px) rotate(${idx * 2}deg)`,
                       zIndex: idx
                     }}
                   >
                      <GameCard card={c} size="sm" hoverable={false} className="w-[calc(var(--board-card-w)-12px)] h-[calc(var(--board-card-h)-12px)]" />
                   </div>
                 ))}

                 {/* Zoom hint on hover (hidden when move button is showing) */}
                 {!targetingActive && onZoomCard && !canMove && (
                   <div className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity bg-black/30 rounded-xl z-20">
                     <ZoomIn className="w-6 h-6 text-white drop-shadow" />
                   </div>
                 )}

                 {/* Move-layer button — shown when this card has an alternate function available */}
                 {canMove && (
                   <button
                     onClick={(e) => {
                       e.stopPropagation();
                       onMoveLayer!(topCard.id);
                     }}
                     title="Move to a different layer"
                     className="absolute bottom-1 right-1 z-30 flex items-center gap-1 px-1.5 py-0.5 rounded-lg bg-primary text-primary-foreground text-[9px] font-bold shadow-lg hover:bg-primary/90 active:scale-95 transition-transform"
                   >
                     <ArrowLeftRight className="w-3 h-3 shrink-0" />
                     Move
                   </button>
                 )}

                 {cards.length > 1 && (
                   <div className="absolute -bottom-2 -right-2 z-10 bg-card border-2 border-primary text-primary font-black text-xs rounded-full w-6 h-6 flex items-center justify-center shadow-lg">
                     {cards.length}
                   </div>
                 )}
               </div>
             )}
          </div>
        );
      })}
    </div>
  );
}
