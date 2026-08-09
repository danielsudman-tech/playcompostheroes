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
  OpponentSummary,
  PILE_CATEGORIES,
  getEffectiveFn,
  collectedCategoryCount,
} from "@/components/facilitated/OpponentSummary";
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
 * Optimized for 13–15" laptops with a non-maximized browser window:
 * everything needed for a normal turn is visible without scrolling.
 */
export default function FacilitatedGame() {
  const { gameId } = useParams();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  // Seat links: facilitators can share /game/:id/table?token=<seatToken> over
  // Zoom/Teams chat. The token is stored then stripped from the URL.
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

  const [viewingOpponent, setViewingOpponent] = useState<PlayerState | null>(null);
  const [confirmCard, setConfirmCard] = useState<Card | null>(null);
  const [viewingDiscard, setViewingDiscard] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showLog, setShowLog] = useState(false);

  // Route guards: wrong mode or missing token → back to the standard game screen
  useEffect(() => {
    if (!gameState) return;
    if (gameState.mode !== "facilitated" || gameState.phase === "waiting" || !storedToken) {
      setLocation(`/game/${gameId}`);
    }
  }, [gameState?.mode, gameState?.phase, storedToken, gameId, setLocation, gameState]);

  // Confetti on game over
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

  if (gameState.mode !== "facilitated" || gameState.phase === "waiting") {
    return null; // guard effect redirects
  }

  const currentPlayer = gameState.players[gameState.currentPlayerIndex];
  const isMyTurn = localPlayerId === currentPlayer.id;
  const me = gameState.players.find((p) => p.id === localPlayerId) ?? currentPlayer;
  const opponents = gameState.players.filter((p) => p.id !== localPlayerId);

  const decision = gameState.pendingDecision;
  const isMyDecision = !!decision && decision.playerId === localPlayerId && !me.isBot;

  // ── Adaptive targeting: player-selection decisions resolve inline on the
  //    opponent strip (eligible opponents highlight; others dim). ──
  const isInlineTargeting = isMyDecision && PLAYER_SELECTION_TYPES.has(decision!.type);
  const eligibleTargetIds = isInlineTargeting
    ? new Set(
        ((decision!.options as any[]) ?? []).map((o) => o.playerId ?? o.targetPlayerId).filter(Boolean)
      )
    : new Set<string>();

  const handleTargetOpponent = (opp: PlayerState) => {
    if (isInlineTargeting && eligibleTargetIds.has(opp.id)) {
      const opt = ((decision!.options as any[]) ?? []).find(
        (o) => (o.playerId ?? o.targetPlayerId) === opp.id
      );
      actionMutation.mutate({
        type: "resolve_decision",
        playerId: localPlayerId!,
        decisionData: { targetPlayerId: opt?.targetPlayerId ?? opt?.playerId ?? opp.id, targetCardId: opt?.targetCardId },
      });
      return;
    }
    if (!isInlineTargeting) setViewingOpponent(opp);
  };

  // Remaining decisions (card / function / generic) use the guided modal
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
  const myCollected = collectedCategoryCount(me.compostPile);

  // Current step text — always visible in the header
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
    <div className="h-screen bg-background game-table-pattern flex flex-col overflow-hidden text-foreground">
      {/* ── HEADER: whose turn + current step, always visible ── */}
      <header className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-card/90 backdrop-blur-md border-b border-border z-20">
        <img src={compostHeroesLogo} alt="Compost Heroes" className="h-7 w-auto shrink-0" draggable={false} />
        <div
          className={cn(
            "flex-1 min-w-0 flex items-center gap-2 rounded-full px-3 py-1 border text-sm font-bold truncate",
            isMyTurn || isMyDecision
              ? "bg-primary/15 border-primary/40 text-primary"
              : "bg-muted/60 border-border text-muted-foreground"
          )}
          data-testid="turn-step-banner"
        >
          {(isMyTurn || isMyDecision) ? <Sparkles className="w-3.5 h-3.5 shrink-0" /> : <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />}
          <span className="truncate">{stepText}</span>
        </div>
        {claim?.playerIndex === 0 && (
          <button
            onClick={() => setLocation(`/game/${gameId}/host`)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold border transition-colors shrink-0 bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/25"
            data-testid="open-facilitator-dashboard"
            title="Open the facilitator dashboard"
          >
            <Crown className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Host</span>
          </button>
        )}
        <button
          onClick={() => setShowLog((v) => !v)}
          className={cn(
            "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold border transition-colors shrink-0",
            showLog ? "bg-amber-600 text-white border-amber-500/60" : "bg-background/80 border-border text-muted-foreground hover:text-foreground"
          )}
          data-testid="toggle-log"
        >
          <History className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Recap</span>
        </button>
        <button
          onClick={() => setShowRules((v) => !v)}
          className={cn(
            "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold border transition-colors shrink-0",
            showRules ? "bg-primary text-primary-foreground border-primary/60" : "bg-background/80 border-border text-muted-foreground hover:text-foreground"
          )}
          data-testid="toggle-rules"
        >
          <BookOpen className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Rules</span>
        </button>
        <div
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold border shrink-0",
            sseConnected ? "bg-green-500/15 border-green-500/30 text-green-600" : "bg-yellow-500/15 border-yellow-500/30 text-yellow-600"
          )}
        >
          <Wifi className={cn("w-3 h-3", !sseConnected && "animate-pulse")} />
          <span className="hidden md:inline">{sseConnected ? claim?.playerName ?? "Online" : "Reconnecting…"}</span>
        </div>
      </header>

      {/* ── OPPONENT STRIP: compact summaries, click to expand ── */}
      <div className="shrink-0 flex gap-2 px-3 pt-3 pb-1 overflow-x-auto z-10">
        {isInlineTargeting && (
          <div className="shrink-0 self-center flex items-center gap-1.5 text-xs font-bold text-destructive bg-destructive/10 border border-destructive/30 rounded-xl px-2.5 py-2 max-w-[11rem]">
            <Crosshair className="w-4 h-4 shrink-0 animate-pulse" />
            <span className="leading-tight">Click a highlighted player</span>
          </div>
        )}
        {opponents.map((opp) => (
          <OpponentSummary
            key={opp.id}
            player={opp}
            isTurn={opp.id === currentPlayer.id}
            modifiers={gameState.activeModifiers.filter((m) => m.appliedByPlayerId === opp.id)}
            targetingActive={isInlineTargeting}
            isEligibleTarget={eligibleTargetIds.has(opp.id)}
            onClick={() => handleTargetOpponent(opp)}
          />
        ))}
      </div>

      {/* ── MIDDLE: draw / discard / ongoing effects ── */}
      <div className="flex-1 min-h-0 flex items-center justify-center gap-4 px-4 z-10">
        {/* Draw pile */}
        <div className="flex flex-col items-center gap-1 shrink-0">
          <div className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Draw</div>
          <div
            className={cn("relative", gameState.phase === "draw" && isMyTurn && "cursor-pointer")}
            onClick={gameState.phase === "draw" && isMyTurn ? handleDrawCard : undefined}
            data-testid="draw-pile"
          >
            <div
              className={cn(
                "w-16 h-24 md:w-20 md:h-28 rounded-lg border-2 shadow-md bg-cover bg-center transition-all",
                gameState.phase === "draw" && isMyTurn
                  ? "border-primary ring-2 ring-primary/50 shadow-primary/30 animate-pulse"
                  : "border-border"
              )}
              style={{ backgroundImage: `url('${assetUrl(CARD_BACK.imageKey)}')` }}
            />
          </div>
          <span className="text-[10px] font-bold bg-background/80 border rounded-full px-2 py-0.5 flex items-center gap-1">
            <Layers className="w-2.5 h-2.5" /> {gameState.deckCount ?? 0}
          </span>
        </div>

        {/* Discard pile — expandable */}
        <div className="flex flex-col items-center gap-1 shrink-0">
          <div className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Discard</div>
          <button
            onClick={gameState.discardPile.length > 0 ? () => setViewingDiscard(true) : undefined}
            className={cn("relative", gameState.discardPile.length > 0 ? "cursor-pointer group" : "cursor-default")}
            title={gameState.discardPile.length > 0 ? "Browse discard pile" : "Empty"}
            data-testid="discard-pile"
          >
            {topDiscard ? (
              <div className="w-16 h-24 md:w-20 md:h-28 rounded-lg overflow-hidden border-2 border-border shadow-md group-hover:ring-2 group-hover:ring-primary/50 transition-all">
                {topDiscard.imageKey ? (
                  <img src={assetUrl(topDiscard.imageKey)} alt={topDiscard.name} className="w-full h-full object-cover" draggable={false} />
                ) : (
                  <GameCard card={topDiscard} size="xs" hoverable={false} className="w-full h-full" />
                )}
              </div>
            ) : (
              <div className="w-16 h-24 md:w-20 md:h-28 rounded-lg border-2 border-dashed border-muted-foreground/25 flex items-center justify-center text-muted-foreground/40 bg-black/5">
                <RefreshCcw className="w-5 h-5" />
              </div>
            )}
          </button>
          <span className="text-[10px] font-bold bg-background/80 border rounded-full px-2 py-0.5">
            {gameState.discardPile.length}
          </span>
        </div>

        {/* Persistent ongoing-effects area */}
        <div className="flex-1 max-w-md min-w-0 self-center bg-card/90 backdrop-blur-md rounded-xl border shadow-md overflow-hidden">
          <div className="bg-gradient-to-r from-orange-500/20 to-yellow-400/10 px-3 py-1 border-b border-border/50 flex items-center gap-1.5">
            <CircleDot className="w-3.5 h-3.5 text-orange-500" />
            <span className="font-display font-bold text-[11px] tracking-wider uppercase">Ongoing Effects</span>
          </div>
          <div className="p-2 flex flex-col gap-1.5 max-h-32 overflow-y-auto">
            {gameState.ongoingActionCard ? (
              <div className="flex items-center gap-2">
                {gameState.ongoingActionCard.imageKey && (
                  <div className="w-8 h-11 rounded overflow-hidden border border-orange-400/40 shrink-0">
                    <img src={assetUrl(gameState.ongoingActionCard.imageKey)} alt={gameState.ongoingActionCard.name} className="w-full h-full object-cover" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-bold text-orange-700 dark:text-orange-400 leading-tight truncate">
                    {gameState.ongoingActionCard.name}
                  </div>
                  <div className="text-[10px] text-muted-foreground leading-snug line-clamp-2">
                    {gameState.ongoingActionCard.cardText}
                  </div>
                </div>
                {isMyTurn && gameState.phase === "play" && !gameState.pendingDecision && ongoing && (
                  <button
                    onClick={handleActivateOngoing}
                    disabled={actionMutation.isPending || !ongoing.canActivate || ongoing.alreadyUsed}
                    title={ongoing.alreadyUsed ? "Already used this turn" : ongoing.hint}
                    className={cn(
                      "shrink-0 text-[10px] font-bold px-2 py-1 rounded-lg border transition-colors",
                      ongoing.alreadyUsed
                        ? "border-muted text-muted-foreground"
                        : ongoing.canActivate
                          ? "border-orange-400/60 text-orange-700 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/30 hover:bg-orange-100/60"
                          : "border-muted text-muted-foreground/50"
                    )}
                    data-testid="activate-ongoing"
                  >
                    {ongoing.alreadyUsed ? "Used ✓" : (<><Zap className="w-2.5 h-2.5 inline mr-0.5" />Use</>)}
                  </button>
                )}
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground/50 italic text-center py-1">No ongoing action card in play</p>
            )}
            {gameState.activeModifiers
              .filter((m) => !gameState.ongoingActionCard || m.cardId !== ((gameState.ongoingActionCard as any).baseId ?? gameState.ongoingActionCard.id))
              .map((mod, i) => (
                <div key={i} className="flex items-start gap-1.5 bg-secondary/10 border border-secondary/20 rounded-lg px-2 py-1">
                  <Sparkles className="w-3 h-3 text-primary shrink-0 mt-0.5" />
                  <div className="min-w-0 text-[10px] leading-tight">
                    <span className="font-bold">{mod.cardName}</span>
                    <span className="text-muted-foreground"> — {mod.effect}</span>
                    <span className="text-muted-foreground/60"> ({gameState.players.find((p) => p.id === mod.appliedByPlayerId)?.name})</span>
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* ── MY AREA: compost progress + hand + turn controls, always visible ── */}
      <div className="shrink-0 bg-card/95 backdrop-blur-md border-t border-border z-20">
        {/* My compost progress row */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/40">
          <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground shrink-0">
            My pile <span className="text-primary">{myCollected}/5</span>
          </span>
          <div className="flex gap-1.5 flex-1 min-w-0 overflow-x-auto">
            {PILE_CATEGORIES.map((cat) => {
              const cards = me.compostPile.filter((c) => c != null && cat.match(getEffectiveFn(c)));
              const top = cards[cards.length - 1] ?? null;
              return (
                <div
                  key={cat.key}
                  title={`${cat.label}: ${cards.length > 0 ? cards.map((c) => c.name).join(", ") : "missing"}`}
                  className={cn(
                    "flex items-center gap-1 rounded-lg border px-1.5 py-0.5 shrink-0",
                    top ? "border-primary/30 bg-primary/5" : "border-dashed border-muted-foreground/25 bg-muted/10 opacity-60"
                  )}
                >
                  <img src={cat.iconSrc} alt={cat.label} className={cn("w-3.5 h-3.5 object-contain", !top && "opacity-30 grayscale")} draggable={false} />
                  <span className={cn("text-[9px] font-bold max-w-[5.5rem] truncate", top ? "text-foreground" : "text-muted-foreground/50")}>
                    {top ? top.name : cat.label}
                  </span>
                  {cards.length > 1 && <span className="text-[8px] font-bold text-primary">×{cards.length}</span>}
                </div>
              );
            })}
          </div>
          {me.skipsNextTurn && <span className="text-[10px] font-bold text-destructive shrink-0">⚠️ Skips next turn</span>}
        </div>

        {/* Hand */}
        <div className="flex items-center gap-1.5 px-3 py-2 overflow-x-auto">
          <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground shrink-0 self-start pt-1">
            Hand<br />
            <span className="font-mono text-foreground/50">{me.hand.length}/{me.maxHandSize}</span>
          </span>
          {me.hand.length === 0 && (
            <span className="text-xs text-muted-foreground/50 italic px-4">No cards in hand</span>
          )}
          {me.hand.filter((c) => c != null).map((card, idx) => {
            const heroBlocked = card.type === "hero" && (gameState.heroPlayedThisTurn || gameState.actionPlayedThisTurn);
            const actionBlocked = card.type === "action" && gameState.actionPlayedThisTurn;
            const isBlocked = heroBlocked || actionBlocked;
            const playable = isPlayPhase && !isBlocked;
            const imageSrc = card.imageKey ? assetUrl(card.imageKey) : null;
            return (
              <motion.button
                key={`${card.id}-${idx}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: isBlocked ? 0.4 : 1, y: 0 }}
                onClick={() => !isBlocked && handleCardClick(card)}
                title={isBlocked ? (heroBlocked ? "Heroes must be played first — one per turn" : "One action per turn") : card.name}
                className={cn(
                  "shrink-0 rounded-lg overflow-hidden w-[88px] h-[128px] md:w-[104px] md:h-[152px] border-2 shadow-sm transition-all",
                  playable
                    ? "border-primary/60 cursor-pointer hover:-translate-y-1.5 hover:shadow-lg hover:shadow-primary/25 hover:z-10"
                    : "border-border",
                  isBlocked && "cursor-not-allowed"
                )}
                data-testid={`hand-card-${card.id}`}
              >
                {imageSrc ? (
                  <img src={imageSrc} alt={card.name} className="w-full h-full object-cover" draggable={false} />
                ) : (
                  <GameCard card={card} size="sm" hoverable={false} className="w-full h-full" />
                )}
              </motion.button>
            );
          })}

          {/* Turn controls */}
          <div className="ml-auto shrink-0 flex flex-col items-stretch gap-1.5 pl-3 self-center">
            {gameState.phase !== "game_over" && isMyTurn && gameState.phase === "draw" && (
              <Button onClick={handleDrawCard} disabled={actionMutation.isPending} className="font-bold rounded-xl px-6" data-testid="button-draw">
                {actionMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Draw Card"}
              </Button>
            )}
            {gameState.phase !== "game_over" && isMyTurn && gameState.phase === "play" && (
              <>
                <span className="text-[10px] font-bold text-primary text-center">Play a card, or:</span>
                <Button variant="secondary" onClick={handleEndTurn} disabled={actionMutation.isPending} className="font-bold rounded-xl px-6" data-testid="button-end-turn">
                  {actionMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "End Turn"}
                </Button>
              </>
            )}
            {gameState.phase !== "game_over" && !isMyTurn && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium px-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span className="whitespace-nowrap">Waiting for {currentPlayer.name}…</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Progressive disclosure panels ── */}

      {/* Rules popover */}
      <AnimatePresence>
        {showRules && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="fixed top-12 right-3 z-[65] w-72 bg-card border border-border rounded-2xl shadow-2xl overflow-hidden"
          >
            <div className="px-4 py-2 bg-muted/50 border-b border-border flex items-center justify-between">
              <span className="font-bold text-xs uppercase tracking-wider">Quick Rules</span>
              <button onClick={() => setShowRules(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 flex flex-col gap-2.5 text-xs text-muted-foreground">
              <div><strong className="text-foreground">1. Draw</strong> — take the top card from the draw pile.</div>
              <div><strong className="text-foreground">2. Play</strong> — play up to 1 hero (first) and 1 action card, or end your turn.</div>
              <div><strong className="text-foreground">Immediate</strong> effects resolve right away; <strong className="text-foreground">Ongoing</strong> cards stay in play until replaced.</div>
              <div className="pt-1 border-t border-border/60"><strong className="text-foreground">Win:</strong> collect 1 hero from each of the 5 compost categories.</div>
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
            className="fixed top-12 right-3 z-[64] w-80 max-w-[92vw] bg-card border border-border rounded-2xl shadow-2xl overflow-hidden"
          >
            <div className="px-4 py-2 bg-muted/50 border-b border-border flex items-center justify-between">
              <span className="font-bold text-xs uppercase tracking-wider flex items-center gap-1.5"><History className="w-3.5 h-3.5 text-amber-600" /> Play-by-Play</span>
              <button onClick={() => setShowLog(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <div className="overflow-y-auto p-2.5 flex flex-col gap-1 text-[11px]" style={{ maxHeight: "45vh" }}>
              {gameState.log.length === 0 && <div className="text-center text-muted-foreground/50 italic py-4">No moves yet.</div>}
              {[...gameState.log].reverse().map((entry, i) => (
                <div key={i} className={cn("py-1 px-1.5 rounded border-b border-border/20 last:border-0 leading-snug", i === 0 ? "bg-amber-50/60 dark:bg-amber-950/20 font-medium" : "text-muted-foreground")}>
                  {entry}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Opponent pile inspection */}
      {viewingOpponent && (
        <OpponentPileModal player={viewingOpponent} onClose={() => setViewingOpponent(null)} />
      )}

      {/* Discard browser */}
      <AnimatePresence>
        {viewingDiscard && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[55] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
            onClick={() => setViewingDiscard(false)}
          >
            <motion.div
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 40, opacity: 0 }}
              className="bg-card w-full max-w-xl rounded-2xl shadow-2xl border border-border overflow-hidden max-h-[80vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
                <div>
                  <h3 className="font-display font-bold text-lg">Discard Pile</h3>
                  <p className="text-[11px] text-muted-foreground">{gameState.discardPile.length} cards — most recent first</p>
                </div>
                <button onClick={() => setViewingDiscard(false)} className="text-muted-foreground hover:text-foreground p-1"><X className="w-5 h-5" /></button>
              </div>
              <div className="overflow-y-auto p-4 flex-1">
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {[...gameState.discardPile].reverse().map((card, idx) => (
                    <div key={`${card.id}-${idx}`} className="flex flex-col gap-1 items-center">
                      <div className="w-full aspect-[2/3] rounded-lg overflow-hidden border border-border shadow-sm">
                        {card.imageKey ? (
                          <img src={assetUrl(card.imageKey)} alt={card.name} className="w-full h-full object-cover" />
                        ) : (
                          <GameCard card={card} size="sm" hoverable={false} className="w-full h-full" />
                        )}
                      </div>
                      <div className="text-[10px] font-bold text-center leading-tight">{card.name}</div>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Play confirmation */}
      <AnimatePresence>
        {confirmCard && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
            onClick={() => setConfirmCard(null)}
          >
            <motion.div
              initial={{ scale: 0.9, y: 24 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 24 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-card rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
            >
              <div className="p-4 flex gap-3 items-start">
                <div className="shrink-0 w-24 h-36 rounded-lg overflow-hidden border border-border shadow-md">
                  {confirmCard.imageKey ? (
                    <img src={assetUrl(confirmCard.imageKey)} alt={confirmCard.name} className="w-full h-full object-cover" />
                  ) : (
                    <GameCard card={confirmCard} size="sm" hoverable={false} className="w-full h-full" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-display font-bold text-base leading-tight">{confirmCard.name}</div>
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    <span className={cn("text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full", confirmCard.type === "hero" ? "bg-green-100 text-green-800" : "bg-blue-100 text-blue-800")}>
                      {confirmCard.type}
                    </span>
                    <span className={cn("text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full", confirmCard.effectType === "ongoing" ? "bg-orange-100 text-orange-800" : "bg-slate-100 text-slate-700")}>
                      {confirmCard.effectType === "ongoing" ? "⬤ Ongoing" : "⚡ Instant"}
                    </span>
                    {confirmCard.function && (
                      <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-secondary/20 text-secondary-foreground">{confirmCard.function}</span>
                    )}
                  </div>
                  <p className="text-xs text-foreground/90 leading-snug mt-2 bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800/40 rounded-lg p-2">
                    {confirmCard.cardText}
                  </p>
                </div>
              </div>
              <div className="px-4 pb-4 flex gap-2">
                <Button className="flex-1 font-bold" onClick={() => handlePlayCard(confirmCard.id)} disabled={actionMutation.isPending} data-testid="confirm-play">
                  {actionMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
                  Play Card
                </Button>
                <Button variant="outline" className="flex-1 font-bold" onClick={() => setConfirmCard(null)}>Cancel</Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Guided decision modal (card / slot / generic choices) */}
      {showDecisionModal && (
        <DecisionModal
          decision={decision!}
          gameState={gameState}
          onResolve={handleResolveDecision}
          stepInfo={getDecisionStepInfo(decision!.type, decision!.meta)}
        />
      )}

      {/* Someone else is choosing */}
      {decision && !isMyDecision && !gameState.players.find((p) => p.id === decision.playerId)?.isBot && (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="fixed bottom-3 left-1/2 -translate-x-1/2 z-[70] max-w-[92vw]">
          <div className="bg-card/97 backdrop-blur-lg border border-border shadow-2xl rounded-2xl px-4 py-2.5 flex items-center gap-2.5">
            <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-bold">{gameState.players.find((p) => p.id === decision.playerId)?.name ?? "Someone"} is choosing…</div>
              <div className="text-xs text-muted-foreground truncate">{decision.prompt}</div>
            </div>
          </div>
        </motion.div>
      )}

      {/* Effect announcement broadcast */}
      <EffectAnnouncementOverlay effect={gameState.lastEffect} />

      {/* Game over */}
      <AnimatePresence>
        {gameState.phase === "game_over" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div initial={{ scale: 0.85, y: 40 }} animate={{ scale: 1, y: 0 }} transition={{ type: "spring", bounce: 0.4 }} className="bg-card w-full max-w-md rounded-3xl shadow-2xl p-6 text-center relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-primary via-secondary to-primary" />
              <img src={compostHeroesLogo} alt="Compost Heroes" className="w-44 mx-auto mb-3 drop-shadow-xl" draggable={false} />
              {localPlayerId === gameState.winner ? (
                <h2 className="text-3xl font-display font-bold text-primary mb-2">You're a Compost Hero!</h2>
              ) : (
                <h2 className="text-3xl font-display font-bold mb-2">
                  <strong className="text-primary">{gameState.players.find((p) => p.id === gameState.winner)?.name ?? "Someone"}</strong> wins!
                </h2>
              )}
              <p className="text-muted-foreground mb-6">The compost pile is complete — well composted!</p>
              <div className="flex justify-center gap-3">
                <Button
                  className="font-bold"
                  disabled={actionMutation.isPending}
                  onClick={() => {
                    const pid = localPlayerId ?? gameState.players[0]?.id;
                    if (pid) actionMutation.mutate({ type: "reset_game" as any, playerId: pid });
                  }}
                >
                  {actionMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Play Again
                </Button>
                <Button variant="outline" className="font-bold" onClick={() => setLocation("/")}>Return to Lobby</Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
