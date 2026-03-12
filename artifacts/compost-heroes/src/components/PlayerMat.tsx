import { motion, AnimatePresence } from "framer-motion";
import { GameCard } from "./GameCard";
import type { PlayerState } from "@workspace/api-client-react";
import { cn, getFunctionBgClass } from "@/lib/utils";
import { Wind, Leaf, Droplets, Sprout, Flame, Hand, User } from "lucide-react";

interface PlayerMatProps {
  player: PlayerState;
  isCurrentPlayer: boolean;
  isLocalUser: boolean; // Are we seeing this player's actual perspective?
  isActiveTurn: boolean;
  onPlayCard?: (cardId: string) => void;
  className?: string;
  compact?: boolean;
}

export function PlayerMat({ 
  player, 
  isCurrentPlayer, 
  isLocalUser, 
  isActiveTurn,
  onPlayCard,
  className,
  compact = false
}: PlayerMatProps) {
  
  // Check which functions they have in their compost pile for the win condition
  const pileFunctions = player.compostPile.map(c => c.function?.toLowerCase() || "");
  const hasAirflow = pileFunctions.some(f => f.includes("air"));
  const hasCarbon = pileFunctions.some(f => f.includes("carbon"));
  const hasMoisture = pileFunctions.some(f => f.includes("moisture"));
  const hasNitrogen = pileFunctions.some(f => f.includes("nitrogen"));
  const hasDecomposer = pileFunctions.some(f => f.includes("decomposer") || f.includes("fire"));

  const WinIcon = ({ has, Icon, colorClass }: { has: boolean, Icon: any, colorClass: string }) => (
    <div className={cn(
      "w-6 h-6 sm:w-8 sm:h-8 rounded-full flex items-center justify-center border-2 transition-all duration-500",
      has ? cn(colorClass, "shadow-sm scale-110") : "bg-muted border-muted-foreground/20 text-muted-foreground/30 grayscale"
    )}>
      <Icon className="w-3 h-3 sm:w-4 sm:h-4" />
    </div>
  );

  if (compact) {
    return (
      <div className={cn(
        "bg-card rounded-2xl p-3 border-2 shadow-sm transition-all relative overflow-hidden",
        isActiveTurn ? "border-primary shadow-primary/20 scale-[1.02]" : "border-transparent",
        className
      )}>
        {isActiveTurn && <div className="absolute top-0 left-0 w-full h-1 bg-primary animate-pulse" />}
        
        <div className="flex justify-between items-center mb-2">
          <h3 className="font-display font-bold text-lg text-foreground flex items-center gap-1">
            <User className="w-4 h-4 text-primary" />
            {player.name}
          </h3>
          <div className="flex items-center gap-1 bg-secondary/10 px-2 py-1 rounded-full text-xs font-bold text-secondary-foreground">
            <Hand className="w-3 h-3" />
            {player.hand.length}
          </div>
        </div>

        {/* Win Condition Tracker */}
        <div className="flex gap-1 mb-3">
          <WinIcon has={hasAirflow} Icon={Wind} colorClass="bg-cyan-100 border-cyan-400 text-cyan-600" />
          <WinIcon has={hasCarbon} Icon={Leaf} colorClass="bg-amber-100 border-amber-600 text-amber-700" />
          <WinIcon has={hasMoisture} Icon={Droplets} colorClass="bg-blue-100 border-blue-500 text-blue-600" />
          <WinIcon has={hasNitrogen} Icon={Sprout} colorClass="bg-lime-100 border-lime-500 text-lime-600" />
          <WinIcon has={hasDecomposer} Icon={Flame} colorClass="bg-orange-100 border-orange-500 text-orange-600" />
        </div>

        {/* Compact Tableau */}
        <div className="text-xs font-bold text-muted-foreground mb-1">Compost Pile ({player.compostPile.length})</div>
        <div className="flex flex-wrap gap-1 min-h-[60px]">
          {player.compostPile.length === 0 ? (
             <div className="w-full h-full min-h-[60px] border-2 border-dashed border-muted rounded-lg flex items-center justify-center text-muted-foreground text-xs italic">
               Empty Pile
             </div>
          ) : (
            player.compostPile.map(card => (
              <div key={card.id} className="relative group cursor-help">
                <div className={cn(
                  "w-10 h-14 rounded border-2 shadow-sm flex items-center justify-center overflow-hidden",
                  getFunctionBgClass(card.function || "")
                )}>
                  {card.imageKey ? (
                    <img src={`${import.meta.env.BASE_URL}assets/${card.imageKey}`} className="w-full h-full object-cover opacity-80" />
                  ) : (
                    <span className="font-bold text-[8px]">{card.name.substring(0, 3)}</span>
                  )}
                </div>
                {/* Tooltip */}
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-32 bg-popover text-popover-foreground text-[10px] p-2 rounded shadow-xl border border-border opacity-0 group-hover:opacity-100 pointer-events-none z-50">
                  <strong className="block mb-0.5">{card.name}</strong>
                  {card.cardText}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  // Full Player View (Bottom of screen)
  return (
    <div className={cn("relative flex flex-col gap-4 p-4 md:p-6 bg-card/80 backdrop-blur-md rounded-t-3xl border-t border-x shadow-2xl", className)}>
      
      {/* Player Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-12 h-12 rounded-full flex items-center justify-center text-xl font-display text-white shadow-md",
            isActiveTurn ? "bg-primary animate-pulse shadow-primary/40" : "bg-muted-foreground"
          )}>
            {player.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <h2 className="text-2xl font-display font-bold text-foreground">
              {player.name} {isLocalUser ? "(You)" : ""}
            </h2>
            {isActiveTurn && <span className="text-sm font-bold text-primary animate-pulse">YOUR TURN</span>}
          </div>
        </div>

        <div className="flex items-center gap-4 bg-background px-4 py-2 rounded-xl shadow-inner border">
          <span className="text-sm font-bold text-muted-foreground uppercase tracking-wider">Win Progress</span>
          <div className="flex gap-2">
            <WinIcon has={hasAirflow} Icon={Wind} colorClass="bg-cyan-100 border-cyan-400 text-cyan-600" />
            <WinIcon has={hasCarbon} Icon={Leaf} colorClass="bg-amber-100 border-amber-600 text-amber-700" />
            <WinIcon has={hasMoisture} Icon={Droplets} colorClass="bg-blue-100 border-blue-500 text-blue-600" />
            <WinIcon has={hasNitrogen} Icon={Sprout} colorClass="bg-lime-100 border-lime-500 text-lime-600" />
            <WinIcon has={hasDecomposer} Icon={Flame} colorClass="bg-orange-100 border-orange-500 text-orange-600" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 relative z-10">
        
        {/* Compost Pile Area */}
        <div className="lg:col-span-3 bg-background/50 rounded-2xl p-4 border border-border/50 shadow-inner min-h-[220px]">
          <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-3 flex items-center gap-2">
            <Sprout className="w-4 h-4" />
            Your Compost Pile
          </h3>
          <div className="flex flex-wrap gap-3">
            <AnimatePresence>
              {player.compostPile.length === 0 ? (
                <motion.div 
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  className="w-full h-36 border-2 border-dashed border-muted-foreground/20 rounded-xl flex items-center justify-center text-muted-foreground"
                >
                  Play Hero cards here to build your pile!
                </motion.div>
              ) : (
                player.compostPile.map((card, idx) => (
                  <motion.div
                    key={card.id}
                    initial={{ scale: 0, rotate: -10 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ type: "spring", delay: idx * 0.05 }}
                  >
                    <GameCard card={card} size="sm" />
                  </motion.div>
                ))
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Stats Area */}
        <div className="bg-background/50 rounded-2xl p-4 border border-border/50 shadow-inner flex flex-col gap-3">
           <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Status</h3>
           <div className="flex justify-between items-center py-2 border-b border-border/50">
             <span className="text-sm text-foreground">Hand Size</span>
             <span className="font-bold">{player.hand.length} / {player.maxHandSize}</span>
           </div>
           {player.skipsNextTurn && (
             <div className="bg-destructive/10 text-destructive text-sm p-2 rounded-md font-bold flex items-center gap-2">
               ⚠️ Skipping next turn
             </div>
           )}
           {player.drawsExtraCard && (
             <div className="bg-primary/10 text-primary text-sm p-2 rounded-md font-bold flex items-center gap-2">
               🔥 +1 Draw Active
             </div>
           )}
        </div>
      </div>

      {/* Hand Area - Absolute positioned to overlap slightly and look like cards in hand */}
      <div className="mt-8 relative h-48 md:h-56">
        <div className="absolute inset-x-0 bottom-0 flex justify-center">
          {player.hand.map((card, idx) => {
            const total = player.hand.length;
            const centerIdx = (total - 1) / 2;
            const offset = idx - centerIdx;
            
            // Fanning math
            const rotate = offset * 5; 
            const y = Math.abs(offset) * 8;
            const x = offset * 40;

            const isPlayable = isActiveTurn && isLocalUser;

            return (
              <motion.div
                key={card.id}
                className="absolute origin-bottom"
                initial={{ y: 200, opacity: 0 }}
                animate={{ 
                  x, 
                  y, 
                  rotate,
                  opacity: 1,
                  zIndex: idx
                }}
                whileHover={isPlayable ? {
                  y: -40,
                  scale: 1.1,
                  rotate: 0,
                  zIndex: 50,
                  transition: { duration: 0.2 }
                } : {}}
                style={{ 
                  transformOrigin: "bottom center"
                }}
              >
                <div className="relative group">
                  <GameCard 
                    card={card} 
                    isFaceDown={!isLocalUser}
                    hoverable={false} // Disable inner hover to use the wrapper hover
                    onClick={() => {
                      if (isPlayable && onPlayCard) {
                        onPlayCard(card.id);
                      }
                    }}
                    className={cn(
                      isPlayable && "cursor-pointer ring-2 ring-transparent hover:ring-primary ring-offset-2 ring-offset-background",
                      !isLocalUser && "opacity-80"
                    )}
                  />
                  {isPlayable && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-[10px] font-bold px-2 py-0.5 rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                      Click to Play
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>

    </div>
  );
}
