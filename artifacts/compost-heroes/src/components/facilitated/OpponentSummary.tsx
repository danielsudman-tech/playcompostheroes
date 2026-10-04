import type { PlayerState, Card } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { matchesCompostFunction } from "@/lib/compostFunctions";
import { assetUrl } from "@/lib/assetUrl";
import { AlertTriangle, Crosshair } from "lucide-react";

export const PILE_CATEGORIES = [
  { key: "moisture",   label: "Moisture",   iconSrc: assetUrl("icon-moisture.png"),   dotFilled: "bg-blue-500",   dotEmpty: "bg-blue-200/60 dark:bg-blue-900/40",   match: (fn: string) => matchesCompostFunction("Moisture", fn) },
  { key: "carbon",     label: "Carbon",     iconSrc: assetUrl("icon-carbon.png"),     dotFilled: "bg-amber-500",  dotEmpty: "bg-amber-200/60 dark:bg-amber-900/40",  match: (fn: string) => matchesCompostFunction("Carbon", fn) },
  { key: "decomposer", label: "Decomposer", iconSrc: assetUrl("icon-decomposer.png"), dotFilled: "bg-orange-500", dotEmpty: "bg-orange-200/60 dark:bg-orange-900/40", match: (fn: string) => matchesCompostFunction("Decomposer", fn) },
  { key: "nitrogen",   label: "Nitrogen",   iconSrc: assetUrl("icon-nitrogen.png"),   dotFilled: "bg-lime-500",   dotEmpty: "bg-lime-200/60 dark:bg-lime-900/40",   match: (fn: string) => matchesCompostFunction("Nitrogen", fn) },
  { key: "airflow",    label: "Airflow",    iconSrc: assetUrl("icon-airflow.png"),    dotFilled: "bg-cyan-500",   dotEmpty: "bg-cyan-200/60 dark:bg-cyan-900/40",   match: (fn: string) => matchesCompostFunction("Airflow", fn) },
];

export function getEffectiveFn(card: Card): string {
  return (card as any).chosenFunction ?? card.function ?? "";
}

export function collectedCategoryCount(pile: Card[]): number {
  return PILE_CATEGORIES.filter((cat) => pile.some((c) => c != null && cat.match(getEffectiveFn(c)))).length;
}

interface OpponentSummaryProps {
  player: PlayerState;
  isTurn: boolean;
  /** Adaptive targeting: a decision is asking me to pick a player. */
  targetingActive: boolean;
  /** This opponent is an eligible target for the pending decision. */
  isEligibleTarget: boolean;
  onClick: () => void;
}

/**
 * Compact, always-visible opponent summary for the Zoom-friendly table:
 * 5 category dots (filled/missing), card count, win proximity, active effects.
 * Click to expand the full pile; highlights when eligible for targeting.
 */
export function OpponentSummary({
  player,
  isTurn,
  targetingActive,
  isEligibleTarget,
  onClick,
}: OpponentSummaryProps) {
  const collected = collectedCategoryCount(player.compostPile);
  const oneAway = collected === 4;
  const dimmed = targetingActive && !isEligibleTarget;

  return (
    <button
      onClick={onClick}
      disabled={dimmed}
      title={
        targetingActive
          ? isEligibleTarget
            ? `Choose ${player.name}`
            : `${player.name} is not an eligible target`
          : `View ${player.name}'s compost pile`
      }
      className={cn(
        "relative shrink-0 text-left rounded-xl border-2 bg-card/90 backdrop-blur-sm px-2.5 py-1.5 transition-all min-w-[9.5rem] max-w-[13rem] flex-1",
        isTurn && !targetingActive ? "border-primary shadow-md shadow-primary/15" : "border-border",
        isEligibleTarget &&
          "border-destructive ring-2 ring-destructive/50 shadow-lg shadow-destructive/20 animate-pulse cursor-pointer scale-[1.03]",
        dimmed && "opacity-35 cursor-not-allowed",
        !targetingActive && "hover:border-primary/60 hover:shadow-md cursor-pointer"
      )}
      data-testid={`opponent-summary-${player.id}`}
    >
      {isTurn && (
        <div className="absolute -top-2 left-2 text-[9px] font-bold uppercase tracking-wider bg-primary text-primary-foreground rounded-full px-1.5 py-px shadow-sm">
          Turn
        </div>
      )}
      {isEligibleTarget && (
        <div className="absolute -top-2 right-2 text-[9px] font-bold uppercase tracking-wider bg-destructive text-destructive-foreground rounded-full px-1.5 py-px shadow-sm flex items-center gap-0.5">
          <Crosshair className="w-2.5 h-2.5" /> Pick
        </div>
      )}

      {/* Name + win proximity */}
      <div className="flex items-center justify-between gap-1.5">
        <span className="font-display font-bold text-[13px] leading-tight truncate">{player.name}</span>
        <span
          className={cn(
            "shrink-0 text-[10px] font-bold rounded-full px-1.5 py-px border",
            oneAway
              ? "bg-red-100 text-red-700 border-red-300 dark:bg-red-950/50 dark:text-red-400"
              : collected >= 3
                ? "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/50 dark:text-amber-400"
                : "bg-muted text-muted-foreground border-border"
          )}
        >
          {oneAway ? "1 away!" : `${collected}/5`}
        </span>
      </div>

      {/* Category dots */}
      <div className="flex items-center gap-1 mt-1">
        {PILE_CATEGORIES.map((cat) => {
          const count = player.compostPile.filter((c) => c != null && cat.match(getEffectiveFn(c))).length;
          const has = count > 0;
          return (
            <div key={cat.key} className="flex flex-col items-center gap-px" title={`${cat.label}: ${has ? `${count} card${count > 1 ? "s" : ""}` : "missing"}`}>
              <img src={cat.iconSrc} alt={cat.label} className={cn("w-3 h-3 object-contain", !has && "opacity-25 grayscale")} draggable={false} />
              <div className={cn("w-2.5 h-2.5 rounded-full border border-black/10", has ? cat.dotFilled : cat.dotEmpty)}>
                {count > 1 && <span className="sr-only">{count}</span>}
              </div>
              <span className={cn("text-[8px] font-bold leading-none", has ? "text-foreground/70" : "text-transparent")}>{count > 1 ? `×${count}` : "·"}</span>
            </div>
          );
        })}
        {/* card count */}
        <div className="ml-auto flex flex-col items-end gap-0.5">
          <span className="text-[10px] font-bold text-muted-foreground whitespace-nowrap">{player.hand.length}</span>
        </div>
      </div>

      {/* Active effects */}
      {player.skipsNextTurn && (
        <div className="flex flex-wrap items-center gap-1 mt-1">
          {player.skipsNextTurn && (
            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold text-destructive bg-destructive/10 border border-destructive/30 rounded-full px-1.5 py-px">
              <AlertTriangle className="w-2.5 h-2.5" /> Skips turn
            </span>
          )}
        </div>
      )}
    </button>
  );
}
