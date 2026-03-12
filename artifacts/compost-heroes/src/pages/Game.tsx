import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import confetti from "canvas-confetti";
import { useGameState, useGameAction } from "@/hooks/use-game";
import { PlayerMat } from "@/components/PlayerMat";
import { GameCard } from "@/components/GameCard";
import { DecisionModal } from "@/components/DecisionModal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { 
  Layers, 
  RefreshCcw, 
  History, 
  AlertCircle, 
  Trophy,
  Loader2,
  Sparkles
} from "lucide-react";
import { cn } from "@/lib/utils";

export default function Game() {
  const { gameId } = useParams();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  
  const { data: gameState, isLoading, error } = useGameState(gameId || null);
  const actionMutation = useGameAction(gameId || "");

  // Local state for identifying "who I am" in Pass & Play mode
  // In Pass & Play, we assume the user looking at the screen is the current player
  // In a real networked version, this would be tied to session/auth
  const localPlayerId = gameState?.players[gameState.currentPlayerIndex]?.id;

  useEffect(() => {
    if (gameState?.phase === "game_over" && gameState.winner) {
      const duration = 3 * 1000;
      const end = Date.now() + duration;

      const frame = () => {
        confetti({
          particleCount: 5,
          angle: 60,
          spread: 55,
          origin: { x: 0 },
          colors: ['#4ade80', '#22c55e', '#16a34a']
        });
        confetti({
          particleCount: 5,
          angle: 120,
          spread: 55,
          origin: { x: 1 },
          colors: ['#f97316', '#fb923c', '#ea580c']
        });

        if (Date.now() < end) {
          requestAnimationFrame(frame);
        }
      };
      frame();
    }
  }, [gameState?.phase, gameState?.winner]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center">
        <Loader2 className="w-12 h-12 text-primary animate-spin mb-4" />
        <h2 className="text-2xl font-display text-foreground">Loading Game State...</h2>
      </div>
    );
  }

  if (error || !gameState) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 text-center">
        <AlertCircle className="w-16 h-16 text-destructive mb-4" />
        <h2 className="text-3xl font-display text-foreground mb-2">Game Not Found</h2>
        <p className="text-muted-foreground mb-6">This compost pile has completely decomposed.</p>
        <Button onClick={() => setLocation("/")}>Back to Lobby</Button>
      </div>
    );
  }

  const currentPlayer = gameState.players[gameState.currentPlayerIndex];
  const isMyTurn = localPlayerId === currentPlayer.id;
  const opponents = gameState.players.filter(p => p.id !== localPlayerId);
  const localPlayerFull = gameState.players.find(p => p.id === localPlayerId) || currentPlayer;

  const handleDrawCard = () => {
    if (!isMyTurn || !localPlayerId) return;
    actionMutation.mutate({ type: "draw_card", playerId: localPlayerId });
  };

  const handleEndTurn = () => {
    if (!isMyTurn || !localPlayerId) return;
    if (actionMutation.isPending) return;
    actionMutation.mutate({ type: "end_turn", playerId: localPlayerId });
  };

  const handlePlayCard = (cardId: string) => {
    if (!isMyTurn || !localPlayerId) return;
    actionMutation.mutate({ type: "play_card", playerId: localPlayerId, cardId });
  };

  const handleResolveDecision = (decisionData: any) => {
    if (!localPlayerId) return;
    actionMutation.mutate({
      type: "resolve_decision",
      playerId: localPlayerId,
      decisionData
    });
  };

  const topCardInDiscard = gameState.discardPile.length > 0 
    ? gameState.discardPile[gameState.discardPile.length - 1] 
    : null;

  return (
    <div className="min-h-screen bg-background game-table-pattern flex flex-col overflow-hidden text-foreground">
      {/* Background Decor */}
      <div className="fixed inset-0 pointer-events-none opacity-[0.03] z-0 mix-blend-multiply">
         <img src={`${import.meta.env.BASE_URL}images/wood-bg.png`} className="w-full h-full object-cover" alt="" />
      </div>

      {/* TOP ROW: Opponents */}
      <div className="relative z-10 flex-none p-4 pb-0 flex justify-center gap-4 overflow-x-auto">
        {opponents.map(opp => (
          <PlayerMat 
            key={opp.id} 
            player={opp} 
            isCurrentPlayer={opp.id === currentPlayer.id}
            isLocalUser={false}
            isActiveTurn={opp.id === currentPlayer.id}
            compact
            className="w-full max-w-[300px] shrink-0"
          />
        ))}
      </div>

      {/* MIDDLE ROW: Board (Deck, Discard, Active Effects, Log) */}
      <div className="relative z-10 flex-1 flex flex-col md:flex-row gap-6 p-6 items-center justify-center">
        
        {/* Left: Game Log (hidden on small screens, drawer maybe?) */}
        <div className="hidden lg:flex flex-col w-64 h-[300px] bg-card/80 backdrop-blur-md border border-border shadow-inner rounded-xl overflow-hidden self-end mb-8">
          <div className="p-3 bg-muted/50 border-b border-border flex items-center gap-2 font-bold text-sm">
            <History className="w-4 h-4" /> Activity Log
          </div>
          <div className="flex-1 p-3 overflow-y-auto flex flex-col gap-2 text-xs">
            {gameState.log.slice(-15).map((entry, i) => (
              <div key={i} className="py-1 border-b border-border/50 last:border-0 text-muted-foreground">
                {entry}
              </div>
            ))}
            {gameState.log.length === 0 && (
              <div className="text-center text-muted-foreground/50 italic mt-4">Game started</div>
            )}
          </div>
        </div>

        {/* Center: Deck & Discard */}
        <div className="flex flex-col items-center gap-4">
          <div className="bg-card/90 backdrop-blur-md p-6 rounded-3xl border shadow-xl flex items-center gap-8 md:gap-12 relative">
            
            {/* Draw Pile */}
            <div className="flex flex-col items-center gap-3">
              <div className="relative group cursor-pointer" onClick={gameState.phase === 'draw' ? handleDrawCard : undefined}>
                <div className={cn(
                  "absolute inset-0 bg-primary/20 blur-xl rounded-full transition-opacity",
                  gameState.phase === 'draw' && isMyTurn ? "opacity-100 animate-pulse" : "opacity-0"
                )} />
                <GameCard 
                  card={gameState.deck[0]} // Pass anything, isFaceDown overrides
                  isFaceDown 
                  hoverable={gameState.phase === 'draw' && isMyTurn}
                  className={cn(
                    "ring-4 ring-transparent transition-all",
                    gameState.phase === 'draw' && isMyTurn && "ring-primary shadow-primary/30 shadow-lg -translate-y-2"
                  )}
                />
                {/* Deck thickness illusion */}
                <div className="absolute top-1 left-1 w-full h-full bg-secondary/80 border-2 border-secondary-foreground/20 rounded-xl -z-10" />
                <div className="absolute top-2 left-2 w-full h-full bg-secondary border-2 border-secondary-foreground/20 rounded-xl -z-20" />
              </div>
              <div className="flex items-center gap-2 bg-background/80 px-3 py-1 rounded-full text-xs font-bold shadow-sm border">
                <Layers className="w-3 h-3 text-muted-foreground" />
                <span>{gameState.deck.length} left</span>
              </div>
            </div>

            {/* Discard Pile */}
            <div className="flex flex-col items-center gap-3">
              <div className="relative">
                {topCardInDiscard ? (
                  <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
                    <GameCard card={topCardInDiscard} hoverable={false} />
                  </motion.div>
                ) : (
                  <div className="w-36 h-52 rounded-xl border-4 border-dashed border-muted-foreground/20 flex flex-col items-center justify-center text-muted-foreground/40 bg-black/5">
                    <RefreshCcw className="w-8 h-8 mb-2" />
                    <span className="text-xs font-bold uppercase">Discard</span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 bg-background/80 px-3 py-1 rounded-full text-xs font-bold shadow-sm border opacity-80">
                <span>{gameState.discardPile.length} discarded</span>
              </div>
            </div>
            
          </div>
          
          {/* Action Controls for Current Player */}
          {isMyTurn && gameState.phase !== "game_over" && (
            <motion.div 
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="bg-primary/10 border border-primary/20 p-2 rounded-2xl flex gap-3 shadow-lg backdrop-blur-md"
            >
              {gameState.phase === 'draw' && (
                <Button size="lg" onClick={handleDrawCard} className="font-bold bg-primary hover:bg-primary/90 text-white rounded-xl shadow-md">
                  Draw Card
                </Button>
              )}
              {gameState.phase === 'play' && (
                <>
                  <div className="flex items-center px-4 font-bold text-primary">
                    Play 1 card below (or skip)
                  </div>
                  <Button 
                    size="lg" 
                    variant="secondary" 
                    onClick={handleEndTurn} 
                    disabled={actionMutation.isPending}
                    className="font-bold rounded-xl shadow-md"
                  >
                    {actionMutation.isPending ? "..." : "End Turn"}
                  </Button>
                </>
              )}
            </motion.div>
          )}

          {!isMyTurn && gameState.phase !== "game_over" && (
            <div className="bg-muted/50 border border-border px-6 py-3 rounded-2xl text-muted-foreground font-bold flex items-center gap-2 backdrop-blur-md">
              <Loader2 className="w-4 h-4 animate-spin" /> Waiting for {currentPlayer.name}...
            </div>
          )}
        </div>

        {/* Right: Active Effects */}
        <div className="hidden lg:flex flex-col w-64 min-h-[300px] bg-card/80 backdrop-blur-md border border-border shadow-inner rounded-xl overflow-hidden self-end mb-8">
          <div className="p-3 bg-secondary/10 border-b border-secondary/20 flex items-center gap-2 font-bold text-sm text-secondary-foreground">
            <Sparkles className="w-4 h-4" /> Active Effects
          </div>
          <div className="flex-1 p-3 overflow-y-auto flex flex-col gap-3">
            {gameState.activeModifiers.length === 0 ? (
              <div className="text-center text-muted-foreground/50 italic mt-4 text-xs">No active ongoing cards</div>
            ) : (
              gameState.activeModifiers.map((mod, i) => (
                <div key={i} className="bg-background border rounded-lg p-2 text-xs shadow-sm">
                  <div className="font-bold text-secondary-foreground mb-1">{mod.cardName}</div>
                  <div className="text-muted-foreground leading-tight">{mod.effect}</div>
                </div>
              ))
            )}
          </div>
        </div>

      </div>

      {/* BOTTOM ROW: Local Player */}
      <div className="relative z-20">
        <PlayerMat 
          player={localPlayerFull} 
          isCurrentPlayer={isMyTurn}
          isLocalUser={true}
          isActiveTurn={isMyTurn}
          onPlayCard={handlePlayCard}
        />
      </div>

      {/* DECISION MODAL OVERLAY */}
      {isMyTurn && gameState.pendingDecision && (
        <DecisionModal 
          decision={gameState.pendingDecision}
          gameState={gameState}
          onResolve={handleResolveDecision}
        />
      )}

      {/* GAME OVER OVERLAY */}
      <AnimatePresence>
        {gameState.phase === "game_over" && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.8, y: 50 }}
              animate={{ scale: 1, y: 0 }}
              transition={{ type: "spring", bounce: 0.5 }}
              className="bg-card w-full max-w-lg rounded-3xl shadow-2xl p-8 text-center relative overflow-hidden"
            >
              <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-primary via-secondary to-primary" />
              <Trophy className="w-24 h-24 text-yellow-500 mx-auto mb-6 drop-shadow-md" />
              <h2 className="text-5xl font-display font-bold text-foreground mb-2">Game Over!</h2>
              <p className="text-2xl text-muted-foreground mb-8">
                <strong className="text-primary">{gameState.players.find(p => p.id === gameState.winner)?.name ?? gameState.winner}</strong> has completed their Compost Pile!
              </p>
              
              <div className="flex justify-center gap-4">
                <Button size="lg" className="font-bold text-lg" onClick={() => setLocation("/")}>
                  Return to Lobby
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
