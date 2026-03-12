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

      {/* MIDDLE ROW: Board — matches physical mat layout */}
      <div className="relative z-10 flex-1 flex flex-row gap-4 px-4 py-2 items-stretch justify-center">

        {/* Left: Activity Log */}
        <div className="hidden lg:flex flex-col w-56 bg-card/80 backdrop-blur-md border border-border shadow-inner rounded-xl overflow-hidden self-center" style={{ maxHeight: 320 }}>
          <div className="px-3 py-2 bg-muted/50 border-b border-border flex items-center gap-2 font-bold text-xs uppercase tracking-wider shrink-0">
            <History className="w-3.5 h-3.5" /> Activity Log
          </div>
          <div className="flex-1 p-2 overflow-y-auto flex flex-col gap-1 text-[11px]">
            {gameState.log.slice(-20).reverse().map((entry, i) => (
              <div key={i} className={cn(
                "py-1 border-b border-border/30 last:border-0 leading-snug",
                i === 0 ? "text-foreground font-medium" : "text-muted-foreground"
              )}>
                {entry}
              </div>
            ))}
            {gameState.log.length === 0 && (
              <div className="text-center text-muted-foreground/50 italic mt-4">Game started</div>
            )}
          </div>
        </div>

        {/* Center: THE CHALLENGE + Draw/Discard */}
        <div className="flex flex-col items-center gap-3 self-center">

          {/* THE CHALLENGE zone */}
          <div className="w-full max-w-sm">
            <div className="bg-card/90 backdrop-blur-md rounded-2xl border shadow-xl overflow-hidden">
              <div className="bg-gradient-to-r from-primary/20 via-primary/10 to-secondary/20 px-4 py-2 border-b border-border/50 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-primary" />
                  <span className="font-display font-bold text-sm tracking-widest uppercase text-foreground">The Challenge</span>
                </div>
                <span className="text-[10px] text-muted-foreground font-bold uppercase">Ongoing Effects</span>
              </div>
              <div className="p-3 min-h-[56px] flex flex-wrap gap-2 items-center">
                {gameState.activeModifiers.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground/50 italic w-full text-center py-2">No active ongoing cards</p>
                ) : (
                  gameState.activeModifiers.map((mod, i) => (
                    <div key={i} className="bg-secondary/10 border border-secondary/20 rounded-lg px-2 py-1.5 text-[10px] shadow-sm max-w-[180px]">
                      <div className="font-bold text-secondary-foreground">{mod.cardName}</div>
                      <div className="text-muted-foreground leading-tight mt-0.5">{mod.effect}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Draw + Discard row */}
          <div className="bg-card/90 backdrop-blur-md px-6 py-4 rounded-3xl border shadow-xl flex items-end gap-10">

            {/* Draw Pile */}
            <div className="flex flex-col items-center gap-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Draw Pile</div>
              <div className="relative group" onClick={gameState.phase === 'draw' && isMyTurn ? handleDrawCard : undefined}>
                <div className={cn(
                  "absolute inset-0 bg-primary/20 blur-xl rounded-full transition-opacity",
                  gameState.phase === 'draw' && isMyTurn ? "opacity-100 animate-pulse" : "opacity-0"
                )} />
                <GameCard
                  card={gameState.deck[0]}
                  isFaceDown
                  hoverable={gameState.phase === 'draw' && isMyTurn}
                  className={cn(
                    "ring-4 ring-transparent transition-all cursor-pointer",
                    gameState.phase === 'draw' && isMyTurn && "ring-primary shadow-primary/30 shadow-lg -translate-y-2"
                  )}
                />
                <div className="absolute top-1 left-1 w-full h-full bg-secondary/80 border-2 border-secondary-foreground/20 rounded-xl -z-10" />
                <div className="absolute top-2 left-2 w-full h-full bg-secondary border-2 border-secondary-foreground/20 rounded-xl -z-20" />
              </div>
              <div className="flex items-center gap-1.5 bg-background/80 px-3 py-1 rounded-full text-xs font-bold shadow-sm border">
                <Layers className="w-3 h-3 text-muted-foreground" />
                {gameState.deck.length} left
              </div>
            </div>

            {/* Discard Pile */}
            <div className="flex flex-col items-center gap-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Discard Pile</div>
              <div className="relative">
                {topCardInDiscard ? (
                  <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
                    <GameCard card={topCardInDiscard} hoverable={false} />
                  </motion.div>
                ) : (
                  <div className="w-36 h-52 rounded-xl border-4 border-dashed border-muted-foreground/20 flex flex-col items-center justify-center text-muted-foreground/40 bg-black/5">
                    <RefreshCcw className="w-8 h-8 mb-2" />
                    <span className="text-xs font-bold uppercase">Empty</span>
                  </div>
                )}
              </div>
              <div className="bg-background/80 px-3 py-1 rounded-full text-xs font-bold shadow-sm border opacity-80">
                {gameState.discardPile.length} discarded
              </div>
            </div>

          </div>

          {/* Turn Controls */}
          {isMyTurn && gameState.phase !== "game_over" && (
            <motion.div
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="bg-primary/10 border border-primary/20 px-4 py-2.5 rounded-2xl flex items-center gap-3 shadow-lg backdrop-blur-md"
            >
              {gameState.phase === 'draw' && (
                <Button size="lg" onClick={handleDrawCard} className="font-bold bg-primary hover:bg-primary/90 text-white rounded-xl shadow-md px-8">
                  Draw Card
                </Button>
              )}
              {gameState.phase === 'play' && (
                <>
                  <span className="font-bold text-primary text-sm">Play a card or skip</span>
                  <Button
                    size="lg"
                    variant="secondary"
                    onClick={handleEndTurn}
                    disabled={actionMutation.isPending}
                    className="font-bold rounded-xl shadow-md"
                  >
                    {actionMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />...</> : "End Turn"}
                  </Button>
                </>
              )}
            </motion.div>
          )}

          {!isMyTurn && gameState.phase !== "game_over" && (
            <div className="bg-muted/50 border border-border px-5 py-2.5 rounded-2xl text-muted-foreground font-bold flex items-center gap-2 backdrop-blur-md text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Waiting for {currentPlayer.name}…
            </div>
          )}
        </div>

        {/* Right: Turn Reference (matches mat reference text) */}
        <div className="hidden lg:flex flex-col w-56 self-center gap-3">
          <div className="bg-card/80 backdrop-blur-md border border-border rounded-xl overflow-hidden shadow-sm">
            <div className="px-3 py-2 bg-muted/50 border-b border-border font-bold text-xs uppercase tracking-wider">On Your Turn</div>
            <div className="p-3 flex flex-col gap-2 text-xs text-muted-foreground">
              <div className="flex items-start gap-2">
                <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground font-bold text-[10px] flex items-center justify-center shrink-0">1</span>
                <span><strong className="text-foreground">Draw</strong> — take the top card from the draw pile</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="w-5 h-5 rounded-full bg-secondary text-secondary-foreground font-bold text-[10px] flex items-center justify-center shrink-0">2</span>
                <span><strong className="text-foreground">Play</strong> — play 1 card from your hand, or skip</span>
              </div>
            </div>
          </div>
          <div className="bg-card/80 backdrop-blur-md border border-border rounded-xl overflow-hidden shadow-sm">
            <div className="px-3 py-2 bg-muted/50 border-b border-border font-bold text-xs uppercase tracking-wider">Card Effects</div>
            <div className="p-3 flex flex-col gap-2 text-xs text-muted-foreground">
              <div><strong className="text-foreground">Immediate</strong> — resolves right away when played</div>
              <div><strong className="text-foreground">Ongoing</strong> — stays in play until end of game or removed</div>
            </div>
          </div>
          <div className="bg-card/80 backdrop-blur-md border border-border rounded-xl overflow-hidden shadow-sm">
            <div className="px-3 py-2 bg-muted/50 border-b border-border font-bold text-xs uppercase tracking-wider">Win Condition</div>
            <div className="p-3 text-xs text-muted-foreground">
              Collect <strong className="text-foreground">1 hero</strong> from each of the 5 categories in your compost pile.
            </div>
          </div>
        </div>

      </div>

      {/* BOTTOM ROW: Local Player mat (category slots + header only) */}
      <div className="relative z-20 pb-36">
        <PlayerMat 
          player={localPlayerFull} 
          isCurrentPlayer={isMyTurn}
          isLocalUser={true}
          isActiveTurn={isMyTurn}
          onPlayCard={handlePlayCard}
        />
      </div>

      {/* HAND OVERLAY — fixed at screen bottom, always visible */}
      <div className="fixed bottom-0 inset-x-0 z-30 pointer-events-none">
        <div className="relative flex justify-center" style={{ height: 170 }}>
          {localPlayerFull.hand.length === 0 && (
            <div className="absolute bottom-4 text-muted-foreground/40 text-sm italic pointer-events-none">
              No cards in hand
            </div>
          )}
          {localPlayerFull.hand.map((card, idx) => {
            const total = localPlayerFull.hand.length;
            const centerIdx = (total - 1) / 2;
            const offset = idx - centerIdx;
            const rotate = offset * 5;
            const arcY = Math.abs(offset) * 8;
            const x = offset * 50;
            const isPlayable = isMyTurn && gameState.phase === "play" && !gameState.pendingDecision;

            return (
              <motion.div
                key={card.id}
                className="absolute bottom-0 origin-bottom pointer-events-auto"
                initial={{ y: 200, opacity: 0 }}
                animate={{ x, y: arcY, rotate, opacity: 1, zIndex: idx + 1 }}
                whileHover={isPlayable ? {
                  y: -50,
                  scale: 1.15,
                  rotate: 0,
                  zIndex: 60,
                  transition: { duration: 0.15 }
                } : {}}
                style={{ transformOrigin: "bottom center" }}
              >
                <div className="relative group">
                  <GameCard
                    card={card}
                    isFaceDown={false}
                    hoverable={false}
                    onClick={() => {
                      if (isPlayable) handlePlayCard(card.id);
                    }}
                    className={cn(
                      isPlayable && "cursor-pointer ring-2 ring-transparent hover:ring-primary ring-offset-1"
                    )}
                  />
                  {isPlayable && (
                    <div className="absolute -top-7 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-[10px] font-bold px-2 py-0.5 rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                      Play
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>
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
