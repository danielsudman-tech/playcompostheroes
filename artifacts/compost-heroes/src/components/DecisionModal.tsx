import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { PendingDecision, GameState } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { GameCard } from "./GameCard";
import { User, CheckSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { assetUrl } from "@/lib/assetUrl";

const FUNCTION_META: Record<string, { label: string; iconSrc: string; color: string; bg: string }> = {
  Airflow:    { label: "Airflow",    iconSrc: assetUrl("icon-airflow.png"),    color: "text-cyan-700",   bg: "bg-cyan-50 border-cyan-400" },
  Carbon:     { label: "Carbon",     iconSrc: assetUrl("icon-carbon.png"),     color: "text-amber-700",  bg: "bg-amber-50 border-amber-400" },
  Moisture:   { label: "Moisture",   iconSrc: assetUrl("icon-moisture.png"),   color: "text-blue-700",   bg: "bg-blue-50 border-blue-400" },
  Nitrogen:   { label: "Nitrogen",   iconSrc: assetUrl("icon-nitrogen.png"),   color: "text-lime-700",   bg: "bg-lime-50 border-lime-400" },
  Decomposer: { label: "Decomposer", iconSrc: assetUrl("icon-decomposer.png"), color: "text-orange-700", bg: "bg-orange-50 border-orange-400" },
};

interface DecisionModalProps {
  decision: PendingDecision | null;
  gameState: GameState;
  onResolve: (data: Record<string, unknown>) => void;
}

const CARD_SELECTION_TYPES = new Set([
  "choose_card_from_hand",
  "choose_card_from_discard",
  "choose_card_from_compost",
  "choose_hero_from_discard",
  "choose_rainstorm_play",
  "choose_rot_roulette_keep",
  "choose_discard_for_spread",
  "choose_under_web_hand_card",
  "choose_under_web_discard_card",
  "choose_nitrogen_boost_discard",
  "choose_rot_regrow_discard",
  "choose_rot_regrow_take",
  "choose_discard_to_limit",
]);

const PLAYER_SELECTION_TYPES = new Set([
  "choose_target_player",
  "choose_opponent_for_steal",
]);

const FUNCTION_SELECTION_TYPES = new Set([
  "choose_function",
  "choose_move_function",
]);

type MultiSelectMode =
  | { mode: "fixed"; count: number; resolveKey: string }
  | { mode: "optional" }
  | null;

function getMultiSelectMode(decision: PendingDecision): MultiSelectMode {
  const type = decision.type;
  const meta = (decision as any).meta ?? {};

  if (type === "choose_rot_roulette_keep") {
    return { mode: "fixed", count: meta.keepCount ?? 2, resolveKey: "keepCardIds" };
  }
  if (type === "choose_discard_for_spread") {
    return { mode: "fixed", count: meta.count ?? 1, resolveKey: "cardIds" };
  }
  if (type === "choose_rot_regrow_discard") {
    return { mode: "fixed", count: 3, resolveKey: "cardIds" };
  }
  if (type === "choose_discard_to_limit") {
    return { mode: "fixed", count: meta.count ?? 1, resolveKey: "cardIds" };
  }
  if (type === "choose_rainstorm_play") {
    return { mode: "optional" };
  }
  return null;
}

export function DecisionModal({ decision, gameState, onResolve }: DecisionModalProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  if (!decision) return null;

  const type = decision.type;
  const isOptional = (decision as any)?.meta?.optional === true;
  const multiMode = getMultiSelectMode(decision);
  const isFixedMulti = multiMode?.mode === "fixed";
  const isOptionalMulti = multiMode?.mode === "optional";
  const fixedCount = isFixedMulti ? (multiMode as any).count : 0;
  const resolveKey = isFixedMulti ? (multiMode as any).resolveKey : "cardIds";

  const isPlayerSelection = PLAYER_SELECTION_TYPES.has(type);
  const isCardSelection = CARD_SELECTION_TYPES.has(type);
  const isFunctionSelection = FUNCTION_SELECTION_TYPES.has(type);

  const toggleCard = (cardId: string) => {
    setSelectedIds(prev => {
      if (prev.includes(cardId)) return prev.filter(id => id !== cardId);
      if (isFixedMulti && prev.length >= fixedCount) return [...prev.slice(1), cardId];
      return [...prev, cardId];
    });
  };

  const handleFixedConfirm = () => {
    if (selectedIds.length !== fixedCount) return;
    onResolve({ [resolveKey]: selectedIds });
    setSelectedIds([]);
  };

  const handleOptionalConfirm = () => {
    onResolve({ cardIds: selectedIds });
    setSelectedIds([]);
  };

  const handleSingleOption = (opt: any) => {
    setSelectedIds([]);
    if (isPlayerSelection) {
      // Backend always expects targetPlayerId — remap from opt.playerId if needed
      onResolve({
        targetPlayerId: opt.targetPlayerId ?? opt.playerId,
        targetCardId: opt.targetCardId,
      });
    } else {
      onResolve(opt);
    }
  };

  const handleSkip = () => {
    setSelectedIds([]);
    if (isOptionalMulti) {
      onResolve({ cardIds: [] });
    } else {
      onResolve({ skip: true });
    }
  };

  const options = (decision as any).options ?? [];

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          className="bg-card w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden border border-border"
        >
          <div className="p-6 bg-primary/10 border-b border-border">
            <h2 className="text-2xl font-display font-bold text-foreground text-center">Action Required</h2>
            <p className="text-center text-muted-foreground mt-2 text-lg">{decision.prompt}</p>
            {isFixedMulti && (
              <p className="text-center text-sm text-primary mt-1 font-bold">
                Select {fixedCount} cards ({selectedIds.length}/{fixedCount} selected)
              </p>
            )}
            {isOptionalMulti && (
              <p className="text-center text-sm text-primary mt-1 font-bold">
                Select cards to play, or skip to play none
              </p>
            )}
          </div>
          
          <div className="p-6 max-h-[60vh] overflow-y-auto">
            {isPlayerSelection && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {options.map((opt: any) => {
                  const targetPlayer = gameState.players.find(p => p.id === opt.playerId || p.id === opt.targetPlayerId);
                  const displayPlayer = targetPlayer || gameState.players.find(p => p.name === opt.playerName);
                  if (!displayPlayer) return null;
                  return (
                    <button
                      key={opt.playerId || opt.targetPlayerId}
                      onClick={() => handleSingleOption(opt)}
                      className="flex items-center gap-4 p-4 rounded-xl border-2 border-border hover:border-primary hover:bg-primary/5 transition-all text-left group"
                    >
                      <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center text-secondary-foreground font-display text-xl group-hover:scale-110 transition-transform">
                        {displayPlayer.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="font-bold text-lg">{displayPlayer.name}</div>
                        <div className="text-sm text-muted-foreground flex items-center gap-1">
                          <User className="w-3 h-3"/> {displayPlayer.compostPile.length} cards in pile
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {isCardSelection && !isPlayerSelection && (
              <div className="flex flex-wrap justify-center gap-3">
                {options.map((opt: any, i: number) => {
                  const cardId = opt.cardId;
                  const card = opt.card 
                    || gameState.discardPile.find(c => c.id === cardId)
                    || gameState.players.flatMap(p => [...p.hand, ...p.compostPile]).find(c => c.id === cardId);
                  
                  const isSelected = selectedIds.includes(cardId);
                  const isAnyMulti = isFixedMulti || isOptionalMulti;
                  const imageSrc = card?.imageKey
                    ? assetUrl(card.imageKey)
                    : null;

                  return (
                    <div key={`${i}-${cardId}`} className="flex flex-col items-center gap-1">
                      <div
                        role="button"
                        onClick={() => isAnyMulti ? toggleCard(cardId) : handleSingleOption(opt)}
                        className={cn(
                          "relative rounded-xl overflow-hidden cursor-pointer transition-all shadow-md",
                          "w-28 aspect-[2/3]",
                          isSelected
                            ? "ring-4 ring-primary scale-105 shadow-lg shadow-primary/30"
                            : "hover:ring-2 hover:ring-primary/60 hover:scale-[1.02]"
                        )}
                      >
                        {imageSrc ? (
                          <img
                            src={imageSrc}
                            alt={card?.name ?? opt.cardName}
                            className="w-full h-full object-cover"
                          />
                        ) : card ? (
                          <GameCard
                            card={card}
                            size="sm"
                            hoverable={false}
                            className="w-full h-full"
                          />
                        ) : (
                          <div className="w-full h-full bg-muted flex flex-col items-center justify-center p-2 text-center gap-1">
                            <span className="font-bold text-xs text-foreground leading-tight">{opt.cardName || opt.cardId}</span>
                          </div>
                        )}
                        {isSelected && (
                          <div className="absolute top-1.5 right-1.5 bg-primary rounded-full p-0.5 shadow-md">
                            <CheckSquare className="w-3.5 h-3.5 text-white" />
                          </div>
                        )}
                      </div>
                      <span className="text-[10px] font-semibold text-muted-foreground text-center max-w-[7rem] leading-tight line-clamp-2">
                        {card?.name ?? opt.cardName ?? opt.cardId}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {isFunctionSelection && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {options.map((opt: any, i: number) => {
                  const fn = opt.function as string;
                  const meta = FUNCTION_META[fn] ?? { label: fn, iconSrc: null, color: "text-muted-foreground", bg: "bg-muted border-border" };
                  return (
                    <button
                      key={i}
                      onClick={() => onResolve({ function: fn })}
                      className={cn(
                        "flex flex-col items-center justify-center gap-2 p-5 rounded-xl border-2 font-bold text-lg transition-all hover:scale-105 hover:shadow-lg",
                        meta.bg, meta.color
                      )}
                    >
                      {meta.iconSrc
                        ? <img src={meta.iconSrc} alt={meta.label} className="w-8 h-8 object-contain" draggable={false} />
                        : <span className="w-8 h-8" />
                      }
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            )}

            {!isCardSelection && !isPlayerSelection && !isFunctionSelection && (
              <div className="flex flex-wrap justify-center gap-4">
                {options.map((opt: any, i: number) => (
                  <Button key={i} size="lg" onClick={() => handleSingleOption(opt)} className="font-bold text-lg px-8">
                    {opt.label || opt.cardName || opt.playerName || "Select Option"}
                  </Button>
                ))}
              </div>
            )}
          </div>
          
          <div className="p-4 bg-muted/50 border-t border-border flex justify-center gap-4">
            {isFixedMulti ? (
              <Button 
                variant="default" 
                size="lg"
                disabled={selectedIds.length !== fixedCount}
                onClick={handleFixedConfirm}
                className="font-bold"
              >
                Confirm {selectedIds.length}/{fixedCount} Selected
              </Button>
            ) : isOptionalMulti ? (
              <>
                <Button variant="ghost" size="lg" onClick={handleSkip}>
                  Skip (Play None)
                </Button>
                <Button
                  variant="default"
                  size="lg"
                  disabled={selectedIds.length === 0}
                  onClick={handleOptionalConfirm}
                  className="font-bold"
                >
                  Play {selectedIds.length} Selected
                </Button>
              </>
            ) : isOptional ? (
              <Button variant="ghost" size="lg" onClick={handleSkip}>
                Skip
              </Button>
            ) : options.some((o: any) => o.skip) ? (
              <Button variant="ghost" onClick={() => handleSingleOption({ skip: true })}>
                Skip Action
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground italic">You must make a choice.</p>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
