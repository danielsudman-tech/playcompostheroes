import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { PendingDecision, GameState } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { GameCard } from "./GameCard";
import { User, CheckSquare } from "lucide-react";
import { cn } from "@/lib/utils";

interface DecisionModalProps {
  decision: PendingDecision | null;
  gameState: GameState;
  onResolve: (data: Record<string, unknown>) => void;
}

export function DecisionModal({ decision, gameState, onResolve }: DecisionModalProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  if (!decision) return null;

  const isMultiSelect = decision.type === "choose_rot_roulette_keep";
  const keepCount = (decision as any)?.meta?.keepCount ?? 2;

  const isPlayerSelection = decision.type === "choose_target_player" || decision.type === "choose_opponent_for_steal";
  const isCardSelection = decision.type.includes("card") || decision.type.includes("hero") || decision.type.includes("discard");

  const toggleCard = (cardId: string) => {
    setSelectedIds(prev => {
      if (prev.includes(cardId)) return prev.filter(id => id !== cardId);
      if (prev.length >= keepCount) return [...prev.slice(1), cardId];
      return [...prev, cardId];
    });
  };

  const handleMultiConfirm = () => {
    if (selectedIds.length !== keepCount) return;
    onResolve({ keepCardIds: selectedIds });
    setSelectedIds([]);
  };

  const handleSingleOption = (opt: any) => {
    setSelectedIds([]);
    onResolve(opt);
  };

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
            {isMultiSelect && (
              <p className="text-center text-sm text-primary mt-1 font-bold">
                Select {keepCount} cards ({selectedIds.length}/{keepCount} selected)
              </p>
            )}
          </div>
          
          <div className="p-6 max-h-[60vh] overflow-y-auto">
            {isPlayerSelection && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {(decision as any).options?.map((opt: any) => {
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
              <div className="flex flex-wrap justify-center gap-4">
                {(decision as any).options?.map((opt: any, i: number) => {
                  const cardId = opt.cardId;
                  const card = opt.card 
                    || gameState.discardPile.find(c => c.id === cardId)
                    || gameState.players.flatMap(p => [...p.hand, ...p.compostPile]).find(c => c.id === cardId);
                  
                  const isSelected = selectedIds.includes(cardId);

                  return (
                    <div key={`${i}-${cardId}`} className="flex flex-col items-center gap-2">
                      {card ? (
                        <div className="relative">
                          <GameCard 
                            card={card} 
                            size="md" 
                            onClick={() => isMultiSelect ? toggleCard(cardId) : handleSingleOption(opt)}
                            className={cn(
                              "ring-4 ring-transparent cursor-pointer transition-all",
                              isSelected ? "ring-primary scale-105 shadow-lg shadow-primary/30" : "hover:ring-primary/50"
                            )}
                          />
                          {isSelected && (
                            <div className="absolute top-2 right-2 bg-primary rounded-full p-1 shadow-md">
                              <CheckSquare className="w-4 h-4 text-white" />
                            </div>
                          )}
                        </div>
                      ) : (
                        <Button onClick={() => isMultiSelect ? toggleCard(cardId) : handleSingleOption(opt)} variant="outline" className={cn("h-32 w-24", isSelected && "border-primary bg-primary/10")}>
                          {opt.cardName || opt.cardId}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {!isCardSelection && !isPlayerSelection && (
              <div className="flex flex-wrap justify-center gap-4">
                {(decision as any).options?.map((opt: any, i: number) => (
                  <Button key={i} size="lg" onClick={() => handleSingleOption(opt)} className="font-bold text-lg px-8">
                    {opt.label || opt.cardName || "Select Option"}
                  </Button>
                ))}
              </div>
            )}
          </div>
          
          <div className="p-4 bg-muted/50 border-t border-border flex justify-center gap-4">
            {isMultiSelect ? (
              <Button 
                variant="default" 
                size="lg"
                disabled={selectedIds.length !== keepCount}
                onClick={handleMultiConfirm}
                className="font-bold"
              >
                Keep {selectedIds.length}/{keepCount} Selected Cards
              </Button>
            ) : (decision as any).options?.some((o: any) => o.skip) ? (
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
