import { useState } from "react";
import { motion } from "framer-motion";
import { cn, getFunctionBgClass, getFunctionColor } from "@/lib/utils";
import type { Card } from "@workspace/api-client-react";
import { Info } from "lucide-react";

interface GameCardProps {
  card: Card;
  isFaceDown?: boolean;
  onClick?: () => void;
  className?: string;
  size?: "sm" | "md" | "lg";
  hoverable?: boolean;
}

export function GameCard({ 
  card, 
  isFaceDown = false, 
  onClick, 
  className,
  size = "md",
  hoverable = true
}: GameCardProps) {
  const [isFlipped, setIsFlipped] = useState(isFaceDown);
  const [showDetails, setShowDetails] = useState(false);

  // Derive styles
  const bgClass = getFunctionBgClass(card.function || "Action");
  const color = getFunctionColor(card.function || "Action");
  
  const sizeClasses = {
    sm: "w-24 h-36 rounded-lg border-2 text-[10px]",
    md: "w-36 h-52 rounded-xl border-[3px] text-xs",
    lg: "w-64 h-96 rounded-2xl border-[4px] text-base"
  };

  const isAction = card.type === "action";

  if (isFaceDown) {
    return (
      <motion.div
        whileHover={hoverable ? { y: -5, boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.3)" } : {}}
        onClick={onClick}
        className={cn(
          "relative bg-secondary/80 border-secondary border-4 cursor-pointer shadow-md overflow-hidden",
          sizeClasses[size],
          className
        )}
      >
        <div className="absolute inset-0 opacity-20 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPgo8cmVjdCB3aWR0aD0iOCIgaGVpZ2h0PSI4IiBmaWxsPSIjZmZmIj48L3JlY3Q+CjxwYXRoIGQ9Ik0wIDBMOCA4Wk04IDBMMCA4WiIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjEiPjwvcGF0aD4KPC9zdmc+')] background-repeat" />
        <div className="absolute inset-2 border-2 border-dashed border-secondary-foreground/30 rounded-md flex items-center justify-center">
          <span className="font-display text-secondary-foreground/50 text-xl tracking-widest rotate-[-45deg]">CH</span>
        </div>
      </motion.div>
    );
  }

  // Attempt to load image, fallback if none
  const imageSrc = card.imageKey ? `${import.meta.env.BASE_URL}assets/${card.imageKey}` : null;

  return (
    <motion.div
      whileHover={hoverable ? { y: -8, scale: 1.02, boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.2)" } : {}}
      onClick={onClick}
      className={cn(
        "relative flex flex-col overflow-hidden bg-card shadow-md transition-shadow group",
        bgClass,
        sizeClasses[size],
        onClick && "cursor-pointer",
        className
      )}
    >
      {/* Header */}
      <div className="px-2 py-1.5 flex justify-between items-start bg-white/40 border-b border-inherit backdrop-blur-sm z-10 shrink-0">
        <h4 className="font-display font-bold text-foreground leading-tight line-clamp-2" style={{ color }}>
          {card.name}
        </h4>
        {size !== "sm" && (
          <div 
            className="w-5 h-5 rounded-full bg-white/80 shadow-sm border border-inherit flex items-center justify-center shrink-0 ml-1"
            title={card.function}
          >
             <span className="text-[10px] font-bold" style={{ color }}>{card.function?.charAt(0)}</span>
          </div>
        )}
      </div>

      {/* Image Area */}
      <div className="flex-1 relative bg-black/5 overflow-hidden flex items-center justify-center min-h-[40%]">
        {imageSrc ? (
          <img 
            src={imageSrc} 
            alt={card.name}
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
              (e.target as HTMLImageElement).parentElement?.classList.add('fallback-bg');
            }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center opacity-10">
            <span className="font-display text-4xl" style={{ color }}>?</span>
          </div>
        )}
        
        {/* Layer / Type Badge */}
        <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-[8px] font-bold bg-background/90 shadow-sm border border-border backdrop-blur-md uppercase tracking-wider text-foreground">
          {isAction ? card.effectType : card.layer || "Hero"}
        </div>
      </div>

      {/* Text Area */}
      <div className="p-2 bg-white/70 backdrop-blur-sm flex flex-col gap-1 shrink-0 z-10 h-[35%] overflow-hidden relative">
        <p className="font-bold leading-tight" style={{ color }}>
          {card.effectType === "instant" ? "⚡ " : "⏳ "}{card.effectType?.toUpperCase()}
        </p>
        <p className={cn(
          "font-medium text-foreground/90 leading-tight flex-1",
          size === "sm" ? "text-[8px] line-clamp-3" : "text-[10px] sm:text-xs overflow-y-auto"
        )}>
          {card.cardText}
        </p>
        
        {/* Hover info button for small sizes */}
        {size === "sm" && (
          <div className="absolute bottom-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Info className="w-3 h-3 text-muted-foreground" />
          </div>
        )}
      </div>

      {/* Fact Text tooltip/overlay (only in md/lg on hover) */}
      {size !== "sm" && hoverable && card.factText && (
        <div className="absolute inset-x-0 bottom-0 translate-y-full group-hover:translate-y-0 transition-transform duration-300 p-2 bg-black/80 text-white text-[10px] z-20 backdrop-blur-md border-t border-white/20">
          <p className="italic">"{card.factText}"</p>
        </div>
      )}
    </motion.div>
  );
}
