import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import type { PlayerState } from "@workspace/api-client-react";
import { GameCard } from "./GameCard";
import { cn } from "@/lib/utils";
import { CheckCircle2 } from "lucide-react";
import { assetUrl } from "@/lib/assetUrl";

const CATEGORIES = [
  { label: "Airflow",    iconSrc: assetUrl("icon-airflow.png"),    match: (fn: string) => fn.toLowerCase().includes("air"),     color: "text-cyan-600" },
  { label: "Carbon",     iconSrc: assetUrl("icon-carbon.png"),     match: (fn: string) => fn.toLowerCase().includes("carbon"),  color: "text-amber-700" },
  { label: "Moisture",   iconSrc: assetUrl("icon-moisture.png"),   match: (fn: string) => fn.toLowerCase().includes("moisture"),color: "text-blue-600" },
  { label: "Nitrogen",   iconSrc: assetUrl("icon-nitrogen.png"),   match: (fn: string) => fn.toLowerCase().includes("nitrogen"),color: "text-lime-600" },
  { label: "Decomposer", iconSrc: assetUrl("icon-decomposer.png"), match: (fn: string) => fn.toLowerCase().includes("decomp") || fn.toLowerCase().includes("fire"), color: "text-orange-600" },
];

interface OpponentPileModalProps {
  player: PlayerState;
  onClose: () => void;
}

export function OpponentPileModal({ player, onClose }: OpponentPileModalProps) {
  const collected = CATEGORIES.filter(cat =>
    player.compostPile.some(c => cat.match(c.function || ""))
  ).length;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.92, y: 24, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          exit={{ scale: 0.92, y: 24, opacity: 0 }}
          transition={{ type: "spring", duration: 0.35 }}
          className="bg-card rounded-3xl shadow-2xl border w-full max-w-2xl overflow-hidden"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <div>
              <h2 className="font-display font-bold text-xl">{player.name}'s Compost Pile</h2>
              <p className="text-sm text-muted-foreground">{collected}/5 categories collected</p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-muted flex items-center justify-center hover:bg-muted/80 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Category rows */}
          <div className="p-5 flex flex-col gap-4 max-h-[70vh] overflow-y-auto">
            {CATEGORIES.map(cat => {
              const cards = player.compostPile.filter(c => cat.match(c.function || ""));
              const has = cards.length > 0;
              return (
                <div key={cat.label}>
                  <div className={cn(
                    "flex items-center gap-2 mb-2 text-sm font-bold uppercase tracking-wider",
                    has ? cat.color : "text-muted-foreground/40"
                  )}>
                    <img src={cat.iconSrc} alt={cat.label} className="w-4 h-4 object-contain" draggable={false} />
                    <span>{cat.label}</span>
                    {has && <CheckCircle2 className="w-4 h-4 ml-1" />}
                    {!has && <span className="font-normal normal-case tracking-normal text-xs ml-1">— not yet collected</span>}
                  </div>
                  {has && (
                    <div className="flex flex-wrap gap-3">
                      {cards.map(card => (
                        <GameCard key={card.id} card={card} size="sm" hoverable />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {player.compostPile.length === 0 && (
              <div className="text-center py-8 text-muted-foreground italic">
                No cards in compost pile yet.
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
