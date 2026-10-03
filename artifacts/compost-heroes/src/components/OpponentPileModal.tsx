import { coverLabel, type CoverFields } from "@/lib/botCover";
import { useState } from "react";
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
  hostControls?: React.ReactNode;
}

export function OpponentPileModal({ player, onClose, hostControls }: OpponentPileModalProps) {
  const [zoomedCard, setZoomedCard] = useState<PlayerState["compostPile"][0] | null>(null);

  const collected = CATEGORIES.filter(cat =>
    player.compostPile.some(c => cat.match(c.function || ""))
  ).length;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={zoomedCard ? () => setZoomedCard(null) : onClose}
      >
        {/* Zoomed card lightbox */}
        <AnimatePresence>
          {zoomedCard && (
            <motion.div
              key="zoom"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ type: "spring", duration: 0.25 }}
              className="absolute inset-0 z-50 flex items-center justify-center p-6"
              onClick={(e) => { e.stopPropagation(); setZoomedCard(null); }}
            >
              <GameCard card={zoomedCard} size="lg" className="w-[min(64vw,16rem)] h-auto aspect-[2/3] max-h-[85dvh]" />
              <p className="absolute bottom-10 text-xs text-white/60 font-medium">Tap anywhere to close</p>
            </motion.div>
          )}
        </AnimatePresence>

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
              {(player as CoverFields).botCovering === true && <p className="text-xs font-bold text-violet-700" data-testid="label-pile-bot-covering">{coverLabel(player.name)}</p>}
              <p className="text-sm text-muted-foreground">{collected}/5 categories · tap a card to enlarge</p>
              {hostControls}
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
                        <button
                          key={card.id}
                          className="focus:outline-none rounded-xl active:scale-95 transition-transform hover:ring-2 hover:ring-primary/40"
                          onClick={() => setZoomedCard(card)}
                          title="Tap to enlarge"
                        >
                          <GameCard card={card} size="sm" hoverable />
                        </button>
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
