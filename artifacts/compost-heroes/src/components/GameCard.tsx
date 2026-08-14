import { motion } from "framer-motion";
import { cn, getFunctionColor } from "@/lib/utils";
import type { Card } from "@workspace/api-client-react";
import { assetUrl } from "@/lib/assetUrl";

interface GameCardProps {
  card: Card;
  isFaceDown?: boolean;
  onClick?: () => void;
  className?: string;
  size?: "xs" | "sm" | "md" | "lg";
  hoverable?: boolean;
  /** Kept for call-site compatibility — no longer used (text is part of the card image). */
  showText?: boolean;
}

const sizeClasses = {
  xs: "w-14 h-20 rounded-md border-2",
  sm: "w-24 h-36 rounded-lg border-[3px]",
  md: "w-36 h-52 rounded-xl border-[3px]",
  lg: "w-64 h-96 rounded-2xl border-[4px]",
};

export function GameCard({
  card,
  isFaceDown = false,
  onClick,
  className,
  size = "md",
  hoverable = true,
}: GameCardProps) {
  if (!card) return null;

  const color = getFunctionColor(card.function || "Action");
  const borderStyle = { borderColor: color };

  if (isFaceDown) {
    return (
      <motion.div
        whileHover={hoverable ? { y: -5, boxShadow: "0 10px 25px -5px rgba(0,0,0,0.3)" } : {}}
        onClick={onClick}
        style={borderStyle}
        className={cn(
          "relative overflow-hidden shadow-md",
          sizeClasses[size],
          onClick && "cursor-pointer",
          className
        )}
      >
        <img
          src={assetUrl("card-back.jpg")}
          alt="Card back"
          className="w-full h-full object-cover"
          draggable={false}
        />
      </motion.div>
    );
  }

  const imageSrc = card.imageKey ? assetUrl(card.imageKey) : null;

  return (
    <motion.div
      whileHover={hoverable ? { y: -8, scale: 1.02, boxShadow: "0 20px 25px -5px rgba(0,0,0,0.2)" } : {}}
      onClick={onClick}
      style={borderStyle}
      className={cn(
        "relative overflow-hidden shadow-md bg-card",
        sizeClasses[size],
        onClick && "cursor-pointer",
        className
      )}
    >
      {imageSrc ? (
        <img
          src={imageSrc}
          alt={card.name}
          className="w-full h-full object-cover"
          draggable={false}
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        // Fallback when no image: show name centred on a tinted background
        <div
          className="w-full h-full flex items-center justify-center p-2 text-center"
          style={{ background: `${color}22` }}
        >
          <span className="font-display font-bold text-sm leading-tight" style={{ color }}>
            {card.name}
          </span>
        </div>
      )}
    </motion.div>
  );
}
