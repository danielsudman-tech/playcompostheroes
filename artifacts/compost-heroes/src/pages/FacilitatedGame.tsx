import { useState, useEffect, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import confetti from "canvas-confetti";
import { assetUrl } from "@/lib/assetUrl";
import compostHeroesLogo from "@assets/Compost_Heroes_Logo_no_background_1773537933517.png";
import {
  useGameState,
  useGameAction,
  useClaimSlot,
  useGameSse,
  getStoredToken,
  storeToken,
} from "@/hooks/use-game";
import { GameCard } from "@/components/GameCard";
import { DecisionModal, PLAYER_SELECTION_TYPES } from "@/components/DecisionModal";
import { EffectAnnouncementOverlay } from "@/components/EffectAnnouncementOverlay";
import { getDecisionStepInfo } from "@/lib/decisionSteps";
import { OpponentPileModal } from "@/components/OpponentPileModal";
import {
  PlayerBoardRow,
  PILE_CATEGORIES,
  getEffectiveFn,
} from "@/components/facilitated/PlayerBoardRow";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import type { PlayerState, Card } from "@workspace/api-client-react";
import {
  Layers,
  RefreshCcw,
  History,
  AlertCircle,
  Loader2,
  Sparkles,
  Zap,
  CircleDot,
  X,
  Wifi,
  BookOpen,
  Crosshair,
  Crown,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

const CARD_BACK = {
  id: "back",
  name: "Card Back",
  type: "unknown" as const,
  layer: null,
  effectType: "instant" as const,
  cardText: "",
  factText: "",
  function: "",
  imageKey: "card-back.jpg",
};

/** Ongoing-benefit activation check (mirrors the engine's ACTIVATABLE cards). */
function getOngoingActivation(gameState: any, me: PlayerState) {
  const card = gameState.ongoingActionCard;
  if (!card) return null;
  const oid = (card as any).baseId ?? card.id;
  const ACTIVATABLE = ["hot_pile_bonus", "critical_mass", "nitrogen_boost", "rot_regrow"];
  if (!ACTIVATABLE.includes(oid)) return null;
  let canActivate = false;
  let hint = "";
  if (oid === "hot_pile_bonus") {
    const n = me.compostPile.filter((c) => getEffectiveFn(c) === "Decomposer").length;
    canActivate = n >= 2;
    hint = canActivate ? "Draw 1 card" : `Need 2 Decomposers (have ${n})`;
  } else if (oid === "critical_mass") {
    const p = me.compostPile as any[];
    canActivate = p.some((c1, i) => p.some((c2, j) => j !== i && c1.layer === c2.layer && c1.layer != null));
    hint = canActivate ? "Draw 1 card" : "Need 2 same-layer cards in pile";
  } else if (oid === "nitrogen_boost") {
    canActivate = me.hand.some((c) => (c as any).function === "Nitrogen");
    hint = canActivate ? "Discard 1 Nitrogen to draw 2" : "Need a Nitrogen card in hand";
  } else if (oid === "rot_regrow") {
    canActivate = me.hand.length >= 3;
    hint = canActivate ? "Discard 3, take 1 from discard" : "Need 3+ cards in hand";
  }
  return { canActivate, hint, alreadyUsed: gameState.ongoingBenefitUsedThisTurn === true };
}

/**
 * Zoom-friendly game table for facilitated corporate sessions.
 * Features a desktop-first shared table matrix where every player's pile is visible.
 */
export default function FacilitatedGame() {
  const { gameId } = useParams();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const urlSeatToken = (() => {
    try {
      return new URLSearchParams(window.location.search).get("token");
    } catch {
      return null;
    }
  })();
  if (gameId && urlSeatToken) {
    storeToken(gameId, urlSeatToken);
    try {
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    } catch {}
  }

  const storedToken = gameId ? getStoredToken(gameId) : null;
  const { data: gameState, isLoading, error } = useGameState(gameId || null, storedToken);
  const isFacilitated = gameState?.mode === "facilitated";

  const { claim, loading: claimLoading } = useClaimSlot(gameId || null, isFacilitated && !!storedToken);
  const localToken = claim?.token ?? storedToken;

  const handleKicked = useCallback(() => {
    if (gameId) {
      try { localStorage.removeItem(`compost_token_${gameId}`); } catch {}
    }
    toast({ title: "You were removed from the room", variant: "destructive" });
    setLocation("/");
  }, [gameId, toast, setLocation]);

  const { sseConnected } = useGameSse(gameId || null, localToken, isFacilitated && !!localToken, handleKicked, (from) => {
    toast({ title: "It's your turn! 🌱", description: `${from} is waiting for you to play.`, duration: 6000 });
  });

  const actionMutation = useGameAction(gameId || "", localToken, {
    onError: (msg) => toast({ title: "Action failed", description: msg, variant: "destructive" }),
  });

  const localPlayerId = claim?.playerId ?? null;

  const [joinName, setJoinName] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [viewingOpponent, setViewingOpponent] = useState<PlayerState | null>(null);
  const [confirmCard, setConfirmCard] = useState<Card | null>(null);
  const [viewingDiscard, setViewingDiscard] = useState(false);
  const [discardIndex, setDiscardIndex] = useState(0);
  const [zoomedCard, setZoomedCard] = useState<Card | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    if (!gameState) return;
    // Only non-facilitated games belong on the classic screen. Facilitated
    // players stay here — the table shows its own name-entry join form
    // (no registration) while the game is waiting.
    if (gameState.mode !== "facilitated") {
      setLocation(`/game/${gameId}`);
    }
  }, [gameState?.mode, gameState?.phase, storedToken, gameId, setLocation, gameState]);

  useEffect(() => {
    if (gameState?.phase === "game_over" && gameState.winner) {
      const end = Date.now() + 2500;
      const frame = () => {
        confetti({ particleCount: 5, angle: 60, spread: 55, origin: { x: 0 }, colors: ["#4ade80", "#22c55e", "#16a34a"] });
        confetti({ particleCount: 5, angle: 120, spread: 55, origin: { x: 1 }, colors: ["#f97316", "#fb923c", "#ea580c"] });
        if (Date.now() < end) requestAnimationFrame(frame);
      };
      frame();
    }
  }, [gameState?.phase, gameState?.winner]);

  if (isLoading || (isFacilitated && claimLoading && !localToken)) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center">
        <Loader2 className="w-10 h-10 text-primary animate-spin mb-3" />
        <h2 className="text-xl font-display text-foreground">Joining table…</h2>
      </div>
    );
  }

  if (error || !gameState) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 text-center">
        <AlertCircle className="w-12 h-12 text-destructive mb-3" />
        <h2 className="text-2xl font-display text-foreground mb-2">Game Not Found</h2>
        <Button onClick={() => setLocation("/")}>Back to Lobby</Button>
      </div>
    );
  }

  if (gameState.mode !== "facilitated") {
    return null;
  }

  if (gameState.phase === "waiting") {
    const handleJoin = async (e: React.FormEvent) => {
      e.preventDefault();
      const name = joinName.trim();
      if (!name || !gameId) return;
      setJoining(true);
      setJoinError(null);
      try {
        const r = await fetch(`/api/games/${gameId}/join`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, password: joinPassword || undefined }),
        });
        const data = await r.json();
        if (r.status === 403 && data.requiresPassword) {
          setNeedsPassword(true);
          if (joinPassword) setJoinError(data.error ?? "Incorrect password");
          setJoining(false);
          return;
        }
        if (!r.ok) throw new Error(data.error ?? "Could not join the game");
        storeToken(gameId, data.token);
        window.location.reload();
      } catch (err) {
        setJoinError(err instanceof Error ? err.message : "Could not join the game");
        setJoining(false);
      }
    };

    return (
      <div className="min-h-screen bg-background game-table-pattern flex flex-col items-center justify-center p-6">
        <img src={compostHeroesLogo} alt="Compost Heroes" className="w-40 mb-6 drop-shadow-md" draggable={false} />
        {localToken ? (
          <div className="bg-card border-2 border-border rounded-3xl p-8 max-w-md w-full text-center shadow-xl">
            <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto mb-4" />
            <h2 className="text-2xl font-display font-bold mb-2">You're at the table!</h2>
            <p className="text-muted-foreground mb-6">Waiting for your facilitator to start the game.</p>
            <div className="bg-muted rounded-2xl p-4 text-left">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Players seated</p>
              <div className="space-y-1.5">
                {gameState.players.map((p) => (
                  <div key={p.id} className="text-sm font-medium flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-primary inline-block" /> {p.name}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={handleJoin} className="bg-card border-2 border-border rounded-3xl p-8 max-w-md w-full text-center shadow-xl">
            <h2 className="text-2xl font-display font-bold mb-2">Join the Game</h2>
            <p className="text-muted-foreground mb-6">Enter your name to take a seat — no account needed.</p>
            <input
              autoFocus
              value={joinName}
              onChange={(e) => setJoinName(e.target.value)}
              placeholder="Your name"
              maxLength={30}
              className="w-full h-12 px-4 rounded-xl border-2 border-border bg-background text-center text-lg font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary mb-4"
              required
            />
            {needsPassword && (
              <input
                type="password"
                value={joinPassword}
                onChange={(e) => setJoinPassword(e.target.value)}
                placeholder="Game password"
                className="w-full h-12 px-4 rounded-xl border-2 border-border bg-background text-center text-lg font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary mb-4"
                required
              />
            )}
            {joinError && <p className="text-sm font-medium text-destructive mb-4">{joinError}</p>}
            <Button type="submit" size="lg" className="w-full h-12 text-lg font-bold" disabled={joining || !joinName.trim()}>
              {joining ? <Loader2 className="w-5 h-5 animate-spin" /> : "Take a Seat"}
            </Button>
          </form>
        )}
      </div>
    );
  }

  const currentPlayer = gameState.players[gameState.currentPlayerIndex];
  const isMyTurn = localPlayerId === currentPlayer.id;
  const me = gameState.players.find((p) => p.id === localPlayerId) ?? currentPlayer;
  
  // Determine turn order so local player is at the bottom
  const localIndex = gameState.players.findIndex(p => p.id === localPlayerId);
  const orderedPlayers = [];
  if (localIndex !== -1) {
    for (let i = 1; i < gameState.players.length; i++) {
      orderedPlayers.push(gameState.players[(localIndex + i) % gameState.players.length]);
    }
  } else {
    orderedPlayers.push(...gameState.players);
  }
  // My own row is rendered pinned above the hand footer (not in the scroll area)
  const myRowPlayer = localIndex !== -1 ? gameState.players[localIndex] : null;

  const decision = gameState.pendingDecision;
  const isMyDecision = !!decision && decision.playerId === localPlayerId && !me.isBot;

  const isInlineTargeting = isMyDecision && PLAYER_SELECTION_TYPES.has(decision!.type);
  const eligibleTargetIds = isInlineTargeting
    ? new Set(((decision!.options as any[]) ?? []).map((o) => o.playerId ?? o.targetPlayerId).filter(Boolean))
    : new Set<string>();

  const handleTargetOpponent = (opp: PlayerState) => {
    if (isInlineTargeting && eligibleTargetIds.has(opp.id)) {
      const opt = ((decision!.options as any[]) ?? []).find((o) => (o.playerId ?? o.targetPlayerId) === opp.id);
      actionMutation.mutate({
        type: "resolve_decision",
        playerId: localPlayerId!,
        decisionData: { targetPlayerId: opt?.targetPlayerId ?? opt?.playerId ?? opp.id, targetCardId: opt?.targetCardId },
      });
    }
  };

  const showDecisionModal = isMyDecision && !isInlineTargeting;

  const handleResolveDecision = (decisionData: any) => {
    if (!localPlayerId) return;
    actionMutation.mutate({ type: "resolve_decision", playerId: localPlayerId, decisionData });
  };

  const handleDrawCard = () => {
    if (!isMyTurn || !localPlayerId || actionMutation.isPending) return;
    actionMutation.mutate({ type: "draw_card", playerId: localPlayerId });
  };
  const handleEndTurn = () => {
    if (!isMyTurn || !localPlayerId || actionMutation.isPending) return;
    actionMutation.mutate({ type: "end_turn", playerId: localPlayerId });
  };
  const handlePlayCard = (cardId: string) => {
    if (!isMyTurn || !localPlayerId || actionMutation.isPending) return;
    setConfirmCard(null);
    actionMutation.mutate({ type: "play_card", playerId: localPlayerId, cardId });
  };
  const handleActivateOngoing = () => {
    if (!isMyTurn || !localPlayerId || actionMutation.isPending) return;
    actionMutation.mutate({ type: "activate_ongoing", playerId: localPlayerId });
  };

  const handleCardClick = (card: Card) => {
    if (!isMyTurn || gameState.phase !== "play" || gameState.pendingDecision) return;
    if (card.type === "hero" && (gameState.heroPlayedThisTurn || gameState.actionPlayedThisTurn)) {
      toast({
        title: gameState.heroPlayedThisTurn ? "One hero per turn" : "Play order",
        description: gameState.heroPlayedThisTurn
          ? "You've already played a hero card this turn."
          : "Heroes must be played before actions.",
        variant: "destructive",
      });
      return;
    }
    if (card.type === "action" && gameState.actionPlayedThisTurn) {
      toast({ title: "One action per turn", description: "You may only play one action card per turn.", variant: "destructive" });
      return;
    }
    setConfirmCard(card);
  };

  const topDiscard = gameState.discardPile[gameState.discardPile.length - 1] ?? null;
  const ongoing = getOngoingActivation(gameState, me);

  const stepText = (() => {
    if (gameState.phase === "game_over") return "Game over";
    if ((gameState as any).paused) return "Game paused by the facilitator";
    if (decision) {
      const owner = gameState.players.find((p) => p.id === decision.playerId);
      return isMyDecision ? `Your choice: ${decision.prompt}` : `${owner?.name ?? "Someone"} is choosing…`;
    }
    if (isMyTurn) return gameState.phase === "draw" ? "Your turn — draw a card" : "Your turn — play a card or end turn";
    return `${currentPlayer.name}'s turn — ${gameState.phase === "draw" ? "drawing" : "playing"}`;
  })();

  const isPlayPhase = isMyTurn && gameState.phase === "play" && !gameState.pendingDecision;

  return (
    <div className="h-[100dvh] bg-background game-table-pattern flex flex-col overflow-hidden text-foreground">
      {/* HEADER */}
      <header className="shrink-0 h-14 flex items-center gap-3 px-4 bg-card/95 backdrop-blur-md border-b border-border shadow-sm z-30 relative">
        <img src={compostHeroesLogo} alt="Compost Heroes" className="h-8 w-auto shrink-0" draggable={false} />
        <div
          className={cn(
            "flex-1 min-w-0 flex items-center gap-2 rounded-xl px-4 py-1.5 border shadow-sm text-sm font-bold truncate transition-colors",
            isMyTurn || isMyDecision
              ? "bg-primary/10 border-primary/40 text-primary"
              : "bg-muted/40 border-border text-muted-foreground"
          )}
        >
          {(isMyTurn || isMyDecision) ? <Sparkles className="w-4 h-4 shrink-0" /> : <Loader2 className="w-4 h-4 shrink-0 animate-spin" />}
          <span className="truncate">{stepText}</span>
        </div>
        
        <div className="flex items-center gap-2 shrink-0">
          {claim?.playerIndex === 0 && (
            <button
              onClick={() => setLocation(`/game/${gameId}/host`)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20"
              title="Open the facilitator dashboard"
            >
              <Crown className="w-4 h-4" /> <span className="hidden sm:inline">Host</span>
            </button>
          )}
          <button
            onClick={() => setShowLog((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors",
              showLog ? "bg-amber-600 text-white border-amber-500" : "bg-card border-border text-muted-foreground hover:bg-muted/50"
            )}
          >
            <History className="w-4 h-4" /> <span className="hidden sm:inline">Recap</span>
          </button>
          <button
            onClick={() => setShowRules((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors",
              showRules ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border text-muted-foreground hover:bg-muted/50"
            )}
          >
            <BookOpen className="w-4 h-4" /> <span className="hidden sm:inline">Rules</span>
          </button>
          <div
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border",
              sseConnected ? "bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-400" : "bg-yellow-500/10 border-yellow-500/30 text-yellow-700 dark:text-yellow-400"
            )}
          >
            <Wifi className={cn("w-3.5 h-3.5", !sseConnected && "animate-pulse")} />
            <span className="hidden md:inline">{sseConnected ? claim?.playerName ?? "Online" : "Reconnecting…"}</span>
          </div>
        </div>
      </header>

      {/* MAIN CONTENT SPLIT */}
      <div className="flex-1 flex flex-row overflow-hidden relative">
        {/* LEFT: Matrix Board + Footer Hand */}
        <div className="flex-1 flex flex-col overflow-hidden relative bg-black/5 shadow-inner">
          
          {/* THE MATRIX BOARD */}
          <div className="flex-1 overflow-auto px-4 py-3 md:px-6 custom-scrollbar">
            <div className="flex flex-col gap-2 w-max mx-auto pb-4">
              
              {/* TARGETING BANNER */}
              {isInlineTargeting && (
                <div className="flex items-center justify-center gap-2 text-sm font-bold text-destructive bg-destructive/10 border border-destructive/30 rounded-xl px-4 py-3 mb-2 animate-pulse shadow-sm w-full">
                  <Crosshair className="w-5 h-5 shrink-0" />
                  <span>Choose a highlighted player for the effect</span>
                </div>
              )}

              {/* MATRIX HEADERS */}
              <div className="flex gap-3 px-3">
                <div className="w-[160px] shrink-0" /> {/* Info spacer */}
                {PILE_CATEGORIES.map(cat => (
                  <div key={cat.key} className={cn("w-[92px] shrink-0 flex items-center justify-center gap-1.5", cat.color)}>
                    <img src={cat.iconSrc} alt={cat.label} className="w-5 h-5 drop-shadow-sm mix-blend-multiply dark:mix-blend-normal" draggable={false} />
                    <span className="font-display font-bold tracking-wide text-[13px] drop-shadow-sm">{cat.label}</span>
                  </div>
                ))}
              </div>

              {/* ROWS */}
              {orderedPlayers.map(p => (
                <PlayerBoardRow
                  key={p.id}
                  player={p}
                  isMe={p.id === localPlayerId}
                  isTurn={p.id === currentPlayer.id}
                  modifiers={gameState.activeModifiers.filter((m) => m.appliedByPlayerId === p.id)}
                  targetingActive={isInlineTargeting}
                  isEligibleTarget={eligibleTargetIds.has(p.id)}
                  onTarget={() => handleTargetOpponent(p)}
                  onViewPile={() => setViewingOpponent(p)}
                  onZoomCard={setZoomedCard}
                />
              ))}
            </div>
          </div>

          {/* MY PINNED PILE ROW */}
          {myRowPlayer && (
            <div className="shrink-0 border-t border-border/40 bg-card/60 backdrop-blur-sm z-10 overflow-x-auto custom-scrollbar">
              <div className="w-max mx-auto px-4 py-1">
                <PlayerBoardRow
                  player={myRowPlayer}
                  isMe
                  isTurn={myRowPlayer.id === currentPlayer.id}
                  modifiers={gameState.activeModifiers.filter((m) => m.appliedByPlayerId === myRowPlayer.id)}
                  targetingActive={isInlineTargeting}
                  isEligibleTarget={eligibleTargetIds.has(myRowPlayer.id)}
                  onTarget={() => handleTargetOpponent(myRowPlayer)}
                  onViewPile={() => setViewingOpponent(myRowPlayer)}
                  onZoomCard={setZoomedCard}
                />
              </div>
            </div>
          )}

          {/* MY HAND FOOTER */}
          <div className="shrink-0 h-[192px] bg-card/95 backdrop-blur-2xl border-t border-border/60 shadow-[0_-10px_40px_rgba(0,0,0,0.1)] z-20 flex flex-col relative before:absolute before:inset-0 before:bg-gradient-to-t before:from-background/20 before:to-transparent before:pointer-events-none">
             <div className="px-6 py-2.5 border-b border-border/40 bg-muted/20 flex justify-between items-center relative z-10">
               <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                 Your Hand <span className="bg-background px-2.5 py-0.5 rounded-full border shadow-sm">{me.hand.length} / {me.maxHandSize}</span>
               </span>
               {me.skipsNextTurn && <span className="text-xs font-bold text-destructive flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5"/> Skips Next Turn</span>}
             </div>
             <div className="flex-1 flex items-center px-8 overflow-x-auto gap-4 custom-scrollbar relative z-10 py-2">
                {me.hand.length === 0 && (
                  <div className="text-muted-foreground/50 italic flex-1 text-center font-medium">No cards in hand</div>
                )}
                {me.hand.filter((c) => c != null).map((card, idx) => {
                  const heroBlocked = card.type === "hero" && (gameState.heroPlayedThisTurn || gameState.actionPlayedThisTurn);
                  const actionBlocked = card.type === "action" && gameState.actionPlayedThisTurn;
                  const isBlocked = heroBlocked || actionBlocked;
                  const playable = isPlayPhase && !isBlocked;
                  
                  return (
                    <motion.div
                      key={`${card.id}-${idx}`}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: isBlocked ? 0.5 : 1, y: 0 }}
                      className="shrink-0 h-full py-2 flex items-center"
                    >
                      <GameCard 
                        card={card} 
                        size="md" 
                        onClick={() => !isBlocked && handleCardClick(card)}
                        className={cn(
                          "transition-all duration-300",
                          playable ? "cursor-pointer hover:-translate-y-4 hover:scale-105 hover:shadow-2xl hover:border-primary ring-offset-background" : "",
                          isBlocked && "cursor-not-allowed grayscale-[20%]"
                        )}
                      />
                    </motion.div>
                  );
                })}
             </div>
          </div>
        </div>

        {/* RIGHT SIDEBAR */}
        <div className="w-[320px] shrink-0 bg-card/95 backdrop-blur-2xl border-l border-border/60 flex flex-col shadow-[-10px_0_40px_rgba(0,0,0,0.1)] z-30">
          
          {/* Decks */}
          <div className="p-6 border-b border-border/40 bg-muted/10 flex justify-center gap-6">
            {/* Draw pile */}
            <div className="flex flex-col items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1"><Layers className="w-3 h-3"/> Draw ({gameState.deckCount ?? 0})</span>
              <div
                className={cn("relative transition-all", gameState.phase === "draw" && isMyTurn && "cursor-pointer hover:-translate-y-1")}
                onClick={gameState.phase === "draw" && isMyTurn ? handleDrawCard : undefined}
                data-testid="draw-pile"
              >
                <div
                  className={cn(
                    "w-24 h-36 rounded-xl border-[3px] shadow-lg bg-cover bg-center transition-all",
                    gameState.phase === "draw" && isMyTurn
                      ? "border-primary ring-4 ring-primary/30 shadow-primary/40 animate-pulse"
                      : "border-border shadow-black/10"
                  )}
                  style={{ backgroundImage: `url('${assetUrl(CARD_BACK.imageKey)}')` }}
                />
              </div>
            </div>

            {/* Discard pile */}
            <div className="flex flex-col items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1"><RefreshCcw className="w-3 h-3"/> Discard ({gameState.discardPile.length})</span>
              <button
                onClick={gameState.discardPile.length > 0 ? () => { setDiscardIndex(0); setViewingDiscard(true); } : undefined}
                className={cn("relative transition-all", gameState.discardPile.length > 0 ? "cursor-pointer hover:-translate-y-1" : "cursor-default")}
                data-testid="discard-pile"
              >
                {topDiscard ? (
                  <GameCard card={topDiscard} size="sm" hoverable={false} className="shadow-lg border-border" />
                ) : (
                  <div className="w-24 h-36 rounded-xl border-[3px] border-dashed border-border/50 flex items-center justify-center bg-black/5 shadow-inner">
                    <RefreshCcw className="w-6 h-6 text-muted-foreground/30" />
                  </div>
                )}
              </button>
            </div>
          </div>

          {/* Ongoing Effects */}
          <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6 custom-scrollbar">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-bold tracking-widest uppercase text-orange-600 dark:text-orange-400 border-b border-border/50 pb-2 mb-3">
                 <CircleDot className="w-3.5 h-3.5" /> Ongoing Card
              </div>
              {gameState.ongoingActionCard ? (
                <div className="flex flex-col gap-3 bg-orange-500/5 border border-orange-500/20 rounded-xl p-3 shadow-sm">
                   <GameCard card={gameState.ongoingActionCard} size="sm" className="mx-auto shadow-md" hoverable={false} />
                   <div className="text-center px-1">
                     <div className="text-sm font-bold text-orange-700 dark:text-orange-400 leading-tight">{gameState.ongoingActionCard.name}</div>
                     <div className="text-[11px] text-muted-foreground mt-1.5 line-clamp-3 leading-snug">{gameState.ongoingActionCard.cardText}</div>
                   </div>
                   {isMyTurn && gameState.phase === "play" && !gameState.pendingDecision && ongoing && (
                     <Button
                       size="sm"
                       onClick={handleActivateOngoing}
                       disabled={actionMutation.isPending || !ongoing.canActivate || ongoing.alreadyUsed}
                       variant={ongoing.alreadyUsed || !ongoing.canActivate ? "secondary" : "default"}
                       className={cn("w-full font-bold mt-1", ongoing.canActivate && !ongoing.alreadyUsed && "bg-orange-500 hover:bg-orange-600 text-white shadow-md")}
                     >
                       {ongoing.alreadyUsed ? "Used this turn" : (ongoing.canActivate ? <><Zap className="w-3 h-3 mr-1.5"/> Activate Effect</> : ongoing.hint)}
                     </Button>
                   )}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground/50 italic text-xs border-2 border-dashed border-border/50 rounded-xl bg-black/5">
                  None active
                </div>
              )}
            </div>

            {gameState.activeModifiers.filter(m => !gameState.ongoingActionCard || m.cardId !== ((gameState.ongoingActionCard as any).baseId ?? gameState.ongoingActionCard.id)).length > 0 && (
              <div>
                <div className="flex items-center gap-2 text-[11px] font-bold tracking-widest uppercase text-primary border-b border-border/50 pb-2 mb-3">
                   <Sparkles className="w-3.5 h-3.5" /> Active Modifiers
                </div>
                <div className="flex flex-col gap-2">
                  {gameState.activeModifiers
                    .filter((m) => !gameState.ongoingActionCard || m.cardId !== ((gameState.ongoingActionCard as any).baseId ?? gameState.ongoingActionCard.id))
                    .map((mod, i) => (
                      <div key={i} className="flex items-start gap-2 bg-primary/5 border border-primary/20 rounded-xl p-3 shadow-sm">
                        <Sparkles className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                        <div className="text-xs leading-snug">
                          <strong className="text-foreground">{mod.cardName}</strong>
                          <span className="text-muted-foreground"> — {mod.effect}</span>
                          <div className="text-muted-foreground/60 mt-1 text-[10px] font-bold uppercase tracking-wider">By {gameState.players.find((p) => p.id === mod.appliedByPlayerId)?.name}</div>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>

          {/* Turn Actions */}
          <div className="h-[220px] p-6 border-t border-border/40 bg-muted/10 flex flex-col justify-center gap-4 relative before:absolute before:inset-0 before:bg-gradient-to-t before:from-background/30 before:to-transparent before:pointer-events-none">
            <div className="relative z-10 flex flex-col gap-4 h-full justify-center">
              {gameState.phase !== "game_over" && isMyTurn ? (
                 gameState.phase === "draw" ? (
                   <>
                     <div className="text-center text-sm font-bold text-primary mb-1 uppercase tracking-widest animate-pulse">Your Turn!</div>
                     <Button size="lg" onClick={handleDrawCard} disabled={actionMutation.isPending} className="font-bold text-lg w-full h-16 shadow-xl hover:-translate-y-0.5 transition-transform bg-primary hover:bg-primary/90">
                       {actionMutation.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : "Draw a Card"}
                     </Button>
                   </>
                 ) : (
                   <>
                     <div className="text-center text-[11px] font-bold text-muted-foreground mb-1 uppercase tracking-widest">Play cards or end turn</div>
                     <Button size="lg" variant="secondary" onClick={handleEndTurn} disabled={actionMutation.isPending} className="font-bold text-lg w-full h-16 border-2 hover:bg-card shadow-md">
                       {actionMutation.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : "End Turn"}
                     </Button>
                   </>
                 )
              ) : (
                 gameState.phase !== "game_over" && (
                   <div className="flex flex-col items-center justify-center gap-3 text-center h-full opacity-60">
                     <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                     <div className="font-display text-lg text-muted-foreground">Waiting for</div>
                     <div className="font-bold text-foreground text-2xl truncate w-full px-4">{currentPlayer.name}</div>
                   </div>
                 )
              )}
            </div>
          </div>

        </div>
      </div>

      {/* Rules popover */}
      <AnimatePresence>
        {showRules && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="fixed top-16 right-[340px] z-[65] w-80 bg-card border border-border rounded-2xl shadow-2xl overflow-hidden"
          >
            <div className="px-4 py-3 bg-muted/50 border-b border-border flex items-center justify-between">
              <span className="font-bold text-xs uppercase tracking-wider">Quick Rules</span>
              <button onClick={() => setShowRules(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 flex flex-col gap-3 text-sm text-muted-foreground">
              <div><strong className="text-foreground">1. Draw</strong> — take the top card from the draw pile.</div>
              <div><strong className="text-foreground">2. Play</strong> — play up to 1 hero (first) and 1 action card, or end your turn.</div>
              <div><strong className="text-foreground">Immediate</strong> effects resolve right away; <strong className="text-foreground">Ongoing</strong> cards stay in play until replaced.</div>
              <div className="pt-2 border-t border-border/60 mt-1"><strong className="text-foreground text-primary">Win Condition:</strong> collect 1 hero from each of the 5 compost categories in your matrix row.</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Play-by-play log */}
      <AnimatePresence>
        {showLog && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="fixed top-16 right-[340px] z-[65] w-80 bg-card border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden max-h-[60vh]"
          >
            <div className="px-4 py-3 bg-muted/50 border-b border-border flex items-center justify-between shrink-0">
              <span className="font-bold text-xs uppercase tracking-wider">Game Recap</span>
              <button onClick={() => setShowLog(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 flex-1 overflow-y-auto flex flex-col gap-2 custom-scrollbar">
              {[...gameState.log].reverse().map((entry, i) => (
                <div key={i} className="text-xs text-muted-foreground py-1 border-b border-border/30 last:border-0 leading-snug">
                  {entry}
                </div>
              ))}
              {gameState.log.length === 0 && <p className="text-xs italic text-muted-foreground text-center">No moves yet.</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Play confirmation modal */}
      <AnimatePresence>
        {confirmCard && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-card rounded-3xl shadow-2xl p-6 border flex flex-col items-center max-w-sm w-full"
            >
              <h2 className="text-xl font-display font-bold mb-4">Play this card?</h2>
              <GameCard card={confirmCard} size="md" className="mb-6 shadow-xl" hoverable={false} />
              <div className="flex w-full gap-3">
                <Button variant="outline" className="flex-1" onClick={() => setConfirmCard(null)}>Cancel</Button>
                <Button className="flex-1 font-bold" onClick={() => handlePlayCard(confirmCard.id)} disabled={actionMutation.isPending}>
                  {actionMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Confirm Play"}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Discard pile browser — 3×3 paged grid */}
      <AnimatePresence>
        {viewingDiscard && (() => {
          const PAGE = 9;
          const pile = [...gameState.discardPile].reverse(); // newest first
          const totalPages = Math.max(1, Math.ceil(pile.length / PAGE));
          const page = Math.min(discardIndex, totalPages - 1);
          const pageCards = pile.slice(page * PAGE, page * PAGE + PAGE);
          return (
            <motion.div
              key="discard-browser"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex flex-col items-center justify-center p-6"
              onClick={() => setViewingDiscard(false)}
            >
              {/* Header */}
              <div className="flex items-center gap-4 mb-5" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-2xl font-display font-bold text-white">Discard Pile</h2>
                <span className="text-white/60 text-sm font-medium">{pile.length} card{pile.length !== 1 ? "s" : ""}</span>
                {totalPages > 1 && (
                  <span className="text-white/40 text-sm">· page {page + 1} of {totalPages}</span>
                )}
                <button
                  onClick={() => setViewingDiscard(false)}
                  className="ml-2 bg-white/10 hover:bg-white/20 text-white rounded-full p-2 backdrop-blur-md transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Grid + page arrows */}
              <div className="flex items-center gap-4" onClick={(e) => e.stopPropagation()}>
                <button
                  disabled={page === 0}
                  onClick={() => setDiscardIndex(p => Math.max(0, p - 1))}
                  className="bg-white/10 hover:bg-white/20 disabled:opacity-20 disabled:cursor-not-allowed text-white rounded-full p-3 backdrop-blur-md transition-colors shrink-0"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>

                <AnimatePresence mode="wait">
                  <motion.div
                    key={page}
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -24 }}
                    transition={{ duration: 0.18 }}
                    className="grid grid-cols-3 gap-3"
                  >
                    {pageCards.map((card, i) => (
                      <div
                        key={`${card.id}-${i}`}
                        className="cursor-zoom-in"
                        onClick={() => setZoomedCard(card)}
                      >
                        <GameCard card={card} size="md" hoverable={false} className="shadow-lg hover:scale-105 transition-transform duration-150" />
                      </div>
                    ))}
                    {/* Fill empty slots so grid stays stable */}
                    {Array.from({ length: PAGE - pageCards.length }).map((_, i) => (
                      <div key={`empty-${i}`} className="w-36 h-52" />
                    ))}
                  </motion.div>
                </AnimatePresence>

                <button
                  disabled={page >= totalPages - 1}
                  onClick={() => setDiscardIndex(p => Math.min(totalPages - 1, p + 1))}
                  className="bg-white/10 hover:bg-white/20 disabled:opacity-20 disabled:cursor-not-allowed text-white rounded-full p-3 backdrop-blur-md transition-colors shrink-0"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
              </div>

              <p className="mt-5 text-white/40 text-xs">Click a card to enlarge · click outside to close</p>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* Card zoom lightbox (click any compost pile card on the board) */}
      <AnimatePresence>
        {zoomedCard && (
          <motion.div
            key="card-zoom"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-6 cursor-zoom-out"
            onClick={() => setZoomedCard(null)}
          >
            <motion.div
              initial={{ scale: 0.8, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.8, y: 20 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
            >
              <GameCard card={zoomedCard} size="lg" hoverable={false} className="shadow-2xl" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Opponent Pile viewer (still useful for zooming specific cards or seeing a stacked list clearly) */}
      {viewingOpponent && (
        <OpponentPileModal player={viewingOpponent} onClose={() => setViewingOpponent(null)} />
      )}

      {/* Decision Modal */}
      {showDecisionModal && (
        <DecisionModal
          decision={decision}
          gameState={gameState}
          onResolve={handleResolveDecision}
          stepInfo={decision ? getDecisionStepInfo(decision.type, decision.meta ?? undefined) : null}
        />
      )}

      {/* Effect Announcements */}
      <EffectAnnouncementOverlay effect={gameState.lastEffect ?? null} />

      {/* Game Over Screen */}
      {gameState.phase === "game_over" && (
        <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.8, y: 50, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            transition={{ type: "spring", bounce: 0.5 }}
            className="bg-card rounded-3xl p-8 md:p-12 max-w-lg w-full text-center border-4 border-primary shadow-2xl relative overflow-hidden"
          >
            <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-primary via-yellow-400 to-primary" />
            <h2 className="text-5xl font-display font-bold text-foreground mb-2">Game Over!</h2>
            <div className="text-2xl font-medium text-muted-foreground mb-8">
              Winner: <span className="font-bold text-primary">{gameState.players.find((p) => p.id === gameState.winner)?.name}</span>
            </div>
            <div className="bg-muted rounded-2xl p-6 mb-8">
              <p className="text-sm text-muted-foreground mb-4 font-medium uppercase tracking-wider">Final Standings</p>
              <div className="space-y-3">
                {[...gameState.players]
                  .sort((a, b) => b.compostPile.length - a.compostPile.length)
                  .map((p, i) => (
                    <div key={p.id} className="flex justify-between items-center text-sm">
                      <span className="font-bold flex items-center gap-2">
                        {i === 0 ? "🏆" : <span className="w-5 text-muted-foreground">{i + 1}.</span>}
                        <span className={p.id === gameState.winner ? "text-primary text-base" : ""}>{p.name}</span>
                      </span>
                      <span className="font-mono text-muted-foreground bg-background px-2 py-0.5 rounded border">
                        {p.compostPile.length} cards
                      </span>
                    </div>
                  ))}
              </div>
            </div>
            <div className="flex flex-col gap-3">
              <Button
                size="lg"
                className="w-full text-lg font-bold h-14"
                disabled={actionMutation.isPending}
                onClick={() => {
                  if (localPlayerId) actionMutation.mutate({ type: "reset_game" as any, playerId: localPlayerId });
                }}
              >
                Play Again
              </Button>
              <Button size="lg" variant="outline" className="w-full text-lg font-bold h-14" onClick={() => setLocation("/")}>
                Return to Lobby
              </Button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}