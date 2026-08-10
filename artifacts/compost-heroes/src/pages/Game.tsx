import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import confetti from "canvas-confetti";
import { assetUrl } from "@/lib/assetUrl";
import compostHeroesLogo from "@assets/Compost_Heroes_Logo_no_background_1773537933517.png";
import { useGameState, useGameAction, useClaimSlot, useGameSse, useJoinRoom, getStoredToken } from "@/hooks/use-game";
import { WaitingRoom } from "@/components/WaitingRoom";
import { PlayerMat } from "@/components/PlayerMat";
import { GameCard } from "@/components/GameCard";
import { DecisionModal } from "@/components/DecisionModal";
import { EffectAnnouncementOverlay, type EffectAnnouncement } from "@/components/EffectAnnouncementOverlay";
import { getDecisionStepInfo } from "@/lib/decisionSteps";
import { OpponentPileModal } from "@/components/OpponentPileModal";
import { TutorialHint, useTutorialMode } from "@/components/TutorialHint";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import type { PlayerState, Card } from "@workspace/api-client-react";
import { 
  Layers,
  RefreshCcw, 
  History, 
  AlertCircle, 
  Trophy,
  Loader2,
  Sparkles,
  Zap,
  CircleDot,
  Leaf,
  X,
  Wifi,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Lock,
  MoveRight,
  Bell,
  BookOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";

const CARD_BACK = { id: "back", name: "Card Back", type: "unknown" as const, layer: null, effectType: "instant" as const, cardText: "", factText: "", function: "", imageKey: "card-back.jpg" };

export default function Game() {
  const { gameId } = useParams();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  // ── Token-based identity for online multiplayer ──
  // 1. Use any token already in localStorage (so returning players get filtered state immediately)
  const storedToken = gameId ? getStoredToken(gameId) : null;

  // 2. Fetch game state (pass stored token so online games are filtered from first load)
  const { data: gameState, isLoading, error } = useGameState(gameId || null, storedToken);
  // Facilitated mode reuses the whole online flow (tokens, SSE, hidden hands)
  // and layers guided announcements/decisions on top.
  const isFacilitated = gameState?.mode === "facilitated";
  const isOnline = gameState?.mode === "online" || isFacilitated;
  const isWaiting = gameState?.phase === "waiting";

  // 3. Claim a slot once we know the mode is online.
  //    For waiting-room games with no stored token, skip auto-claim — the join form handles it.
  const { claim, loading: claimLoading, requiresPassword, doClaim, error: claimError } = useClaimSlot(
    gameId || null,
    isOnline && (!isWaiting || !!storedToken)
  );
  const localToken = claim?.token ?? storedToken;

  // 4. Subscribe to SSE for real-time updates (online mode only; need a token)
  const handleKicked = useCallback(() => {
    if (gameId) {
      try { localStorage.removeItem(`compost_token_${gameId}`); } catch {}
    }
    toast({ title: "You were removed from the room", variant: "destructive" });
    setLocation("/");
  }, [gameId, toast, setLocation]);
  const { sseConnected } = useGameSse(gameId || null, localToken, isOnline && !!localToken, handleKicked, (from) => {
    toast({
      title: "It's your turn! 🌱",
      description: `${from} is waiting for you to play.`,
      duration: 6000,
    });
  });

  // 5. Join-form state (for waiting-room newcomers)
  const joinRoom = useJoinRoom(gameId || null);
  const [joinName, setJoinName] = useState("");
  const [joinRoomPassword, setJoinRoomPassword] = useState("");

  const actionMutation = useGameAction(gameId || "", isOnline ? localToken : null, {
    onError: (msg) => toast({ title: "Action failed", description: msg, variant: "destructive" }),
  });

  const { tutorialEnabled, toggleTutorial } = useTutorialMode();
  const [showPlayLog, setShowPlayLog] = useState(false);

  // Player identity:
  // - Online: fixed to the claimed slot (even when it's not your turn)
  // - Pass & Play: always follows whoever's turn it currently is
  const localPlayerId = isOnline
    ? (claim?.playerId ?? null)
    : gameState?.players[gameState.currentPlayerIndex]?.id;

  // State for viewing an opponent's compost pile
  const [viewingOpponent, setViewingOpponent] = useState<PlayerState | null>(null);

  // State for card play confirmation modal
  const [confirmCard, setConfirmCard] = useState<Card | null>(null);

  // State for browsing the discard pile
  const [viewingDiscard, setViewingDiscard] = useState(false);

  // Mobile bottom panel: hand or pile view

  // Ref for the scrollable hand container
  const handScrollRef = useRef<HTMLDivElement>(null);

  // Password prompt (online games that require a password to join)
  const [joinPassword, setJoinPassword] = useState("");

  // On-screen effect announcement banner
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const announcementTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLogLength = useRef(0);

  // Pass Device screen — shown in Pass & Play when the current player changes
  const [passScreen, setPassScreen] = useState<{ name: string; cardCount: number } | null>(null);
  const prevPlayerIndexRef = useRef<number | null>(null);
  const isFirstRender = useRef(true);

  const [handPileOpen, setHandPileOpen] = useState(false);

  // Sound effect utility (Web Audio API — no external files needed)
  const playSound = useCallback((type: "draw" | "play_action" | "play_hero" | "error") => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      switch (type) {
        case "draw":
          osc.type = "sine";
          osc.frequency.setValueAtTime(330, ctx.currentTime);
          osc.frequency.linearRampToValueAtTime(520, ctx.currentTime + 0.12);
          gain.gain.setValueAtTime(0.18, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
          osc.start(); osc.stop(ctx.currentTime + 0.22);
          break;
        case "play_action":
          osc.type = "triangle";
          osc.frequency.setValueAtTime(440, ctx.currentTime);
          osc.frequency.linearRampToValueAtTime(660, ctx.currentTime + 0.15);
          gain.gain.setValueAtTime(0.22, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
          osc.start(); osc.stop(ctx.currentTime + 0.28);
          break;
        case "play_hero":
          osc.type = "sine";
          osc.frequency.setValueAtTime(523, ctx.currentTime);
          osc.frequency.setValueAtTime(659, ctx.currentTime + 0.1);
          osc.frequency.setValueAtTime(784, ctx.currentTime + 0.22);
          gain.gain.setValueAtTime(0.2, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
          osc.start(); osc.stop(ctx.currentTime + 0.45);
          break;
        case "error":
          osc.type = "sawtooth";
          osc.frequency.setValueAtTime(220, ctx.currentTime);
          osc.frequency.linearRampToValueAtTime(110, ctx.currentTime + 0.18);
          gain.gain.setValueAtTime(0.18, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
          osc.start(); osc.stop(ctx.currentTime + 0.22);
          break;
      }
      setTimeout(() => ctx.close(), 1000);
    } catch (_) {
      // Audio not available in this environment
    }
  }, []);

  // Facilitated rooms use the dedicated Zoom-friendly table layout once play begins.
  // Online mode is untouched — this only redirects facilitated-mode players with a token.
  useEffect(() => {
    if (isFacilitated && gameState && gameState.phase !== "waiting" && localToken) {
      setLocation(`/game/${gameId}/table`);
    }
  }, [isFacilitated, gameState?.phase, localToken, gameId, setLocation]);

  useEffect(() => {
    // Pass screen only makes sense in Pass & Play (same device)
    if (!gameState || gameState.phase === "game_over" || isOnline) return;
    const idx = gameState.currentPlayerIndex;
    if (isFirstRender.current) {
      isFirstRender.current = false;
      prevPlayerIndexRef.current = idx;
      return;
    }
    if (prevPlayerIndexRef.current !== null && prevPlayerIndexRef.current !== idx) {
      const newPlayer = gameState.players[idx];
      // Don't show pass screen for bot players — they play instantly server-side
      if (!(newPlayer as any).isBot) {
        setPassScreen({ name: newPlayer.name, cardCount: newPlayer.hand.length });
      }
    }
    prevPlayerIndexRef.current = idx;
  }, [gameState?.currentPlayerIndex, isOnline]);


  // Announce new log entries as on-screen banners
  useEffect(() => {
    if (!gameState?.log) return;
    const logLen = gameState.log.length;
    if (logLen > prevLogLength.current) {
      const latest = gameState.log[logLen - 1];
      prevLogLength.current = logLen;
      // Facilitated mode has the richer effect-announcement overlay instead
      if (isFacilitated) return;
      setAnnouncement(latest);
      if (announcementTimer.current) clearTimeout(announcementTimer.current);
      announcementTimer.current = setTimeout(() => setAnnouncement(null), 3500);
    }
  }, [gameState?.log?.length]);

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

  if (isLoading || (isOnline && claimLoading && !localToken)) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center">
        <Loader2 className="w-12 h-12 text-primary animate-spin mb-4" />
        <h2 className="text-2xl font-display text-foreground">
          {isOnline ? "Joining game..." : "Loading Game State..."}
        </h2>
      </div>
    );
  }

  // ── Waiting-room: join form (for newcomers without a token) ──────────────────
  if (isWaiting && isOnline && !localToken) {
    const hasPassword = (gameState as any)?.hasPassword as boolean | undefined;
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <img src={assetUrl("card-back.jpg")} alt="Compost Heroes" className="w-24 mx-auto rounded-xl shadow-lg mb-4" draggable={false} />
            <h1 className="text-3xl font-display font-bold text-foreground mb-2">Join Room</h1>
            <p className="text-muted-foreground text-sm">Enter your name to join this game.</p>
          </div>

          <form
            className="bg-card/80 backdrop-blur-xl rounded-3xl shadow-xl border border-border p-6 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const name = joinName.trim();
              if (!name) return;
              joinRoom.mutate({ name, password: joinRoomPassword.trim() || undefined });
            }}
          >
            <input
              autoFocus
              placeholder="Your name"
              value={joinName}
              onChange={(e) => setJoinName(e.target.value)}
              className="w-full h-12 px-4 rounded-xl border-2 border-border bg-background/50 text-base font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
            {hasPassword && (
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
                <input
                  type="password"
                  placeholder="Room password"
                  value={joinRoomPassword}
                  onChange={(e) => setJoinRoomPassword(e.target.value)}
                  className="w-full h-12 pl-9 pr-4 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                />
              </div>
            )}
            {joinRoom.error && (
              <p className="text-xs text-destructive text-center font-medium">{joinRoom.error.message}</p>
            )}
            <button
              type="submit"
              disabled={joinRoom.isPending || !joinName.trim()}
              className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-bold text-base hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {joinRoom.isPending ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : "Join Game"}
            </button>
            <button
              type="button"
              className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setLocation("/")}
            >
              Back to Lobby
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── Waiting-room: lobby view (for joined players) ─────────────────────────────
  if (isWaiting && isOnline && localToken) {
    const playerIndex = claim?.playerIndex ?? null;
    return (
      <WaitingRoom
        gameId={gameId!}
        players={gameState!.players}
        maxPlayers={(gameState as any)?.maxPlayers ?? 4}
        playerIndex={playerIndex}
        token={localToken}
        hasPassword={(gameState as any)?.hasPassword}
        isFacilitated={isFacilitated}
      />
    );
  }

  if (isOnline && requiresPassword && !localToken) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-20 h-20 bg-primary/10 rounded-full mb-4 ring-8 ring-primary/5">
              <Lock className="w-9 h-9 text-primary" />
            </div>
            <h1 className="text-3xl font-display font-bold text-foreground mb-2">Password Required</h1>
            <p className="text-muted-foreground text-sm">This game is protected. Enter the password to join.</p>
          </div>

          <form
            className="bg-card/80 backdrop-blur-xl rounded-3xl shadow-xl border border-border p-6 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              doClaim(joinPassword.trim() || undefined);
            }}
          >
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
              <input
                type="password"
                autoFocus
                placeholder="Enter game password"
                value={joinPassword}
                onChange={(e) => setJoinPassword(e.target.value)}
                className="w-full h-12 pl-9 pr-4 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
            {claimLoading && (
              <p className="text-xs text-muted-foreground text-center flex items-center justify-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Checking…
              </p>
            )}
            {claimError && !claimLoading && (
              <p className="text-xs text-destructive text-center font-medium">{claimError}</p>
            )}
            <button
              type="submit"
              disabled={claimLoading || !joinPassword.trim()}
              className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-bold text-base hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {claimLoading ? "Joining…" : "Join Game"}
            </button>
            <button
              type="button"
              className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setLocation("/")}
            >
              Back to Lobby
            </button>
          </form>
        </div>
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
    if (!isMyTurn || !localPlayerId || actionMutation.isPending) return;
    playSound("draw");
    actionMutation.mutate({ type: "draw_card", playerId: localPlayerId });
  };

  const handleEndTurn = () => {
    if (!isMyTurn || !localPlayerId) return;
    if (actionMutation.isPending) return;
    actionMutation.mutate({ type: "end_turn", playerId: localPlayerId });
  };

  const handlePlayCard = (cardId: string) => {
    if (!isMyTurn || !localPlayerId) return;
    if (actionMutation.isPending) return;
    // Verify the card is still in hand before dispatching
    const card = localPlayerFull.hand.find(c => c.id === cardId);
    if (!card) {
      setConfirmCard(null);
      toast({ title: "Card no longer available", description: "That card is not in your hand.", variant: "destructive" });
      return;
    }
    playSound(card.type === "hero" ? "play_hero" : "play_action");
    setConfirmCard(null);
    actionMutation.mutate({ type: "play_card", playerId: localPlayerId, cardId });
  };

  const handleActivateOngoing = () => {
    if (!isMyTurn || !localPlayerId || actionMutation.isPending) return;
    actionMutation.mutate({ type: "activate_ongoing", playerId: localPlayerId });
  };

  const handleCardClick = (card: Card) => {
    if (!isMyTurn || gameState?.phase !== "play" || gameState?.pendingDecision) return;
    // Block hero if already played one, OR if an action was played first (order rule)
    if (card.type === "hero" && (gameState?.heroPlayedThisTurn || gameState?.actionPlayedThisTurn)) {
      if (gameState?.heroPlayedThisTurn) {
        toast({ title: "One hero per turn", description: "You've already played a hero card this turn.", variant: "destructive" });
      } else {
        toast({ title: "Play order", description: "You already played an action card — heroes must come before actions.", variant: "destructive" });
      }
      return;
    }
    // Block second action card — only 1 per turn regardless of whether a hero was played
    if (card.type === "action" && gameState?.actionPlayedThisTurn) {
      toast({ title: "One action per turn", description: "You may only play one action card per turn.", variant: "destructive" });
      return;
    }
    setConfirmCard(card);
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
    <>
    <div className="min-h-screen md:h-screen bg-background game-table-pattern flex flex-col overflow-x-hidden md:overflow-hidden text-foreground">
      {/* Background Decor */}
      <div className="fixed inset-0 pointer-events-none opacity-[0.03] z-0 mix-blend-multiply">
         <img src={`${import.meta.env.BASE_URL}images/wood-bg.png`} className="w-full h-full object-cover" alt="" />
      </div>

      {/* Tutorial toggle button + Play Log button */}
      {gameState.phase !== "waiting" && gameState.phase !== "game_over" && (
        <div className="fixed top-3 left-3 z-50 flex items-center gap-1.5">
          <button
            onClick={toggleTutorial}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md border shadow-sm transition-colors duration-200",
              tutorialEnabled
                ? "bg-primary text-primary-foreground border-primary/50"
                : "bg-background/90 border-border text-muted-foreground hover:text-foreground"
            )}
          >
            <BookOpen className="w-3.5 h-3.5" />
            {tutorialEnabled ? "Guide On" : "Guide Off"}
          </button>
          <button
            onClick={() => setShowPlayLog(v => !v)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md border shadow-sm transition-colors duration-200",
              showPlayLog
                ? "bg-amber-600 text-white border-amber-500/50"
                : "bg-background/90 border-border text-muted-foreground hover:text-foreground"
            )}
          >
            <History className="w-3.5 h-3.5" />
            Recap
          </button>
        </div>
      )}

      {/* Tutorial hint panel */}
      {tutorialEnabled && gameState.phase !== "waiting" && gameState.phase !== "game_over" && (
        <TutorialHint
          gameState={gameState}
          isMyTurn={isMyTurn}
          localPlayerId={localPlayerId ?? null}
        />
      )}

      {/* Play-by-play log panel */}
      <AnimatePresence>
        {showPlayLog && (
          <motion.div
            key="play-log"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ type: "spring", bounce: 0.2, duration: 0.35 }}
            className="fixed left-3 right-3 bottom-3 z-[60] max-w-lg mx-auto bg-card/97 backdrop-blur-lg border border-border shadow-2xl rounded-2xl overflow-hidden"
            style={{ maxHeight: "55vh" }}
          >
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/40 shrink-0">
              <div className="flex items-center gap-2 font-bold text-sm">
                <History className="w-4 h-4 text-amber-600" />
                Play-by-Play
              </div>
              <button onClick={() => setShowPlayLog(false)} className="text-muted-foreground hover:text-foreground p-1 rounded-full hover:bg-muted transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto p-3 flex flex-col gap-1 text-xs" style={{ maxHeight: "calc(55vh - 44px)" }}>
              {gameState.log.length === 0 && (
                <div className="text-center text-muted-foreground/50 italic py-6">No moves yet.</div>
              )}
              {[...gameState.log].reverse().map((entry, i) => (
                <div key={i} className={cn(
                  "py-1.5 px-2 rounded-lg border-b border-border/20 last:border-0 leading-snug",
                  i === 0 ? "bg-amber-50/60 text-foreground font-medium" : "text-muted-foreground"
                )}>
                  {entry}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Online mode badge */}
      {isOnline && (
        <div className={cn(
          "fixed top-3 right-3 z-50 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold backdrop-blur-md border transition-colors duration-500",
          sseConnected
            ? "bg-green-500/15 border-green-500/30 text-green-600"
            : "bg-yellow-500/15 border-yellow-500/30 text-yellow-600"
        )}>
          <Wifi className={cn("w-3 h-3", !sseConnected && "animate-pulse")} />
          {sseConnected ? "Online" : "Reconnecting…"}
          {claim?.playerName && sseConnected && <span className="opacity-70">· {claim.playerName}</span>}
        </div>
      )}

      {/* EFFECT ANNOUNCEMENT BANNER */}
      <AnimatePresence>
        {announcement && (
          <motion.div
            key={announcement}
            initial={{ opacity: 0, y: -40, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            transition={{ type: "spring", bounce: 0.35, duration: 0.4 }}
            className="fixed top-4 left-1/2 -translate-x-1/2 z-[80] pointer-events-none max-w-[90vw]"
          >
            <div className="bg-card/95 backdrop-blur-md border border-border shadow-2xl rounded-2xl px-5 py-3 flex items-center gap-3">
              <Sparkles className="w-4 h-4 text-primary shrink-0" />
              <span className="text-sm font-semibold text-foreground leading-snug text-center">{announcement}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* TOP ROW: Opponents */}
      <div className="relative z-10 flex-none py-2 px-4 pb-0 flex justify-center gap-4 overflow-x-auto">
        {opponents.map(opp => {
          const oppIndex = gameState.players.findIndex(p => p.id === opp.id);
          const isOppTurn = opp.id === currentPlayer.id;
          return (
            <div key={opp.id} className="flex flex-col items-center gap-1 w-full max-w-[300px] shrink-0">
              <PlayerMat 
                player={opp} 
                isCurrentPlayer={isOppTurn}
                isLocalUser={false}
                isActiveTurn={isOppTurn}
                onViewPile={() => setViewingOpponent(opp)}
                compact
                className="w-full"
              />
              {isOnline && !isMyTurn && isOppTurn && localToken && (
                <button
                  className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground border border-border rounded-full px-3 py-0.5 bg-card/80 hover:bg-card transition-colors active:scale-95"
                  onClick={() => {
                    fetch(`/api/games/${gameId}/nudge`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ token: localToken, targetPlayerIndex: oppIndex }),
                    }).catch(() => {});
                  }}
                >
                  <Bell className="w-3 h-3" />
                  Nudge {opp.name}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* MIDDLE ROW: Board — matches physical mat layout. On mobile: auto height + pb-[520px] keeps content scrollable above fixed overlay. */}
      <div className="relative z-10 md:flex-1 md:min-h-0 flex flex-row gap-4 px-4 py-2 pb-[520px] md:pb-2 items-stretch justify-center">

        {/* Left: Activity Log */}
        <div className="hidden lg:flex flex-col w-56 bg-card/80 backdrop-blur-md border border-border shadow-inner rounded-xl overflow-hidden self-center" style={{ maxHeight: 220 }}>
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

        {/* Center: Draw/Discard + Ongoing Action */}
        <div className="flex flex-col items-center gap-3 self-center">

          {/* Draw + Discard row — top of center */}
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
                  card={CARD_BACK as any}
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
                {gameState.deckCount ?? 0} left
              </div>
            </div>

            {/* Discard Pile */}
            <div className="flex flex-col items-center gap-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Discard Pile</div>
              <div
                className={cn("relative group", gameState.discardPile.length > 0 && "cursor-pointer")}
                onClick={gameState.discardPile.length > 0 ? () => setViewingDiscard(true) : undefined}
                title={gameState.discardPile.length > 0 ? "Click to browse discard pile" : undefined}
              >
                {topCardInDiscard ? (
                  <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="relative">
                    <GameCard card={topCardInDiscard} hoverable={gameState.discardPile.length > 0} />
                    {gameState.discardPile.length > 0 && (
                      <div className="absolute inset-0 rounded-xl bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity bg-black/70 text-white text-xs font-bold px-2 py-1 rounded-full flex items-center gap-1">
                          <History className="w-3 h-3" /> Browse
                        </div>
                      </div>
                    )}
                  </motion.div>
                ) : (
                  <div className="w-36 h-52 rounded-xl border-4 border-dashed border-muted-foreground/20 flex flex-col items-center justify-center text-muted-foreground/40 bg-black/5">
                    <RefreshCcw className="w-8 h-8 mb-2" />
                    <span className="text-xs font-bold uppercase">Empty</span>
                  </div>
                )}
              </div>
              <button
                onClick={gameState.discardPile.length > 0 ? () => setViewingDiscard(true) : undefined}
                disabled={gameState.discardPile.length === 0}
                className="bg-background/80 px-3 py-1 rounded-full text-xs font-bold shadow-sm border opacity-80 hover:opacity-100 disabled:cursor-default hover:bg-muted transition-colors"
              >
                {gameState.discardPile.length} discarded
              </button>
            </div>

          </div>

          {/* Ongoing Action Card + Hero Effects — below draw/discard */}
          <div className="w-full max-w-sm space-y-2">

            {/* Ongoing Action Card Slot */}
            <div className="bg-card/90 backdrop-blur-md rounded-2xl border shadow-xl overflow-hidden">
              <div className="bg-gradient-to-r from-orange-500/20 via-orange-400/10 to-yellow-400/10 px-4 py-2 border-b border-border/50 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CircleDot className="w-4 h-4 text-orange-500" />
                  <span className="font-display font-bold text-sm tracking-widest uppercase text-foreground">Ongoing Action</span>
                </div>
                <span className="text-[10px] text-muted-foreground font-bold uppercase">Active Until Replaced</span>
              </div>
              <div className="p-3 flex items-center gap-3 min-h-[72px]">
                {gameState.ongoingActionCard ? (
                  <>
                    {gameState.ongoingActionCard.imageKey ? (
                      <div className="w-12 h-16 rounded-lg overflow-hidden border-2 border-orange-400/40 shrink-0 shadow-md">
                        <img
                          src={assetUrl(gameState.ongoingActionCard.imageKey)}
                          alt={gameState.ongoingActionCard.name}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ) : (
                      <div className="w-12 h-16 rounded-lg border-2 border-orange-400/40 bg-orange-50 flex items-center justify-center shrink-0 shadow-md">
                        <CircleDot className="w-5 h-5 text-orange-400" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-sm text-foreground leading-tight">{gameState.ongoingActionCard.name}</div>
                      <div className="text-[11px] text-muted-foreground leading-snug mt-1">{gameState.ongoingActionCard.cardText}</div>
                      {isMyTurn && gameState.phase === "play" && !gameState.pendingDecision &&
                        (() => {
                          const oid = (gameState.ongoingActionCard as any).baseId ?? gameState.ongoingActionCard!.id;
                          const ACTIVATABLE = ["hot_pile_bonus", "critical_mass", "nitrogen_boost", "rot_regrow"];
                          if (!ACTIVATABLE.includes(oid)) return null;

                          // Per-card activation condition check
                          let canActivate = false;
                          let conditionHint = "";
                          if (oid === "hot_pile_bonus") {
                            const decomposers = localPlayerFull.compostPile.filter(
                              c => ((c as any).chosenFunction ?? (c as any).function) === "Decomposer"
                            ).length;
                            canActivate = decomposers >= 2;
                            conditionHint = canActivate ? "Draw 1 card" : `Need 2 Decomposers in pile (have ${decomposers})`;
                          } else if (oid === "critical_mass") {
                            const pile = localPlayerFull.compostPile as any[];
                            canActivate = pile.some((c1, i) =>
                              pile.some((c2, j) => j !== i && c1.layer === c2.layer && c1.layer != null)
                            );
                            conditionHint = canActivate ? "Draw 1 card" : "Need 2 cards of the same layer in pile";
                          } else if (oid === "nitrogen_boost") {
                            canActivate = localPlayerFull.hand.some(c => (c as any).function === "Nitrogen");
                            conditionHint = canActivate ? "Discard 1 Nitrogen card to draw 2" : "Need a Nitrogen card in hand";
                          } else if (oid === "rot_regrow") {
                            canActivate = localPlayerFull.hand.length >= 3;
                            conditionHint = canActivate ? "Discard 3 cards then take 1 from discard" : "Need at least 3 cards in hand";
                          }

                          const alreadyUsed = (gameState as any).ongoingBenefitUsedThisTurn === true;
                          const disabled = actionMutation.isPending || !canActivate || alreadyUsed;
                          const title = alreadyUsed
                            ? "Already used this turn"
                            : conditionHint;

                          return (
                            <Button
                              size="sm"
                              variant="outline"
                              className="mt-2 w-full text-xs font-bold border-orange-400/60 text-orange-700 hover:bg-orange-50 dark:hover:bg-orange-950/30 h-7"
                              onClick={handleActivateOngoing}
                              disabled={disabled}
                              title={title}
                            >
                              <Zap className="w-3 h-3 mr-1" />
                              {alreadyUsed ? "Effect Used ✓" : "Activate Effect"}
                            </Button>
                          );
                        })()}
                    </div>
                  </>
                ) : (
                  <p className="text-[11px] text-muted-foreground/50 italic w-full text-center py-1">No ongoing action card in play</p>
                )}
              </div>
            </div>

            {/* Active Hero Modifiers */}
            {gameState.activeModifiers.filter(m => !gameState.ongoingActionCard || m.cardId !== ((gameState.ongoingActionCard as any).baseId ?? gameState.ongoingActionCard.id)).length > 0 && (
              <div className="bg-card/90 backdrop-blur-md rounded-2xl border shadow-xl overflow-hidden">
                <div className="bg-gradient-to-r from-primary/20 via-primary/10 to-secondary/20 px-4 py-2 border-b border-border/50 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-primary" />
                  <span className="font-display font-bold text-sm tracking-widest uppercase text-foreground">Hero Effects</span>
                </div>
                <div className="p-3 flex flex-wrap gap-2 items-start">
                  {gameState.activeModifiers
                    .filter(m => !gameState.ongoingActionCard || m.cardId !== ((gameState.ongoingActionCard as any).baseId ?? gameState.ongoingActionCard.id))
                    .map((mod, i) => (
                      <div key={i} className="bg-secondary/10 border border-secondary/20 rounded-lg px-2 py-1.5 text-[10px] shadow-sm max-w-[180px]">
                        <div className="font-bold text-secondary-foreground">{mod.cardName}</div>
                        <div className="text-muted-foreground leading-tight mt-0.5">{mod.effect}</div>
                      </div>
                    ))}
                </div>
              </div>
            )}

          </div>

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

      {/* BOTTOM ROW: spacer for the fixed bottom overlay */}
      <div
        className="hidden md:block"
        style={{ paddingBottom: handPileOpen ? 500 : 110 }}
      />

      {/* HAND + PILE OVERLAY — fixed at screen bottom, unified toggle */}
      <div className="fixed bottom-0 inset-x-0 z-30 pointer-events-none">

        {/* ── DESKTOP wrapper ── */}
        {(() => {
          const hand = localPlayerFull.hand;
          const isPlayPhase = isMyTurn && gameState.phase === "play" && !gameState.pendingDecision;
          return (
            <div className="hidden md:flex md:flex-col pointer-events-auto">

              {/* Collapsible: pile + ongoing + hand */}
              <AnimatePresence initial={false}>
              {handPileOpen && (
                <motion.div
                  key="desktop-panel"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: "easeInOut" }}
                  className="overflow-hidden bg-card/95 backdrop-blur-md border-t border-border"
                >
                  {/* Pile */}
                  <div className="border-b border-border/40">
                    <PlayerMat
                      player={localPlayerFull}
                      isCurrentPlayer={isMyTurn}
                      isLocalUser={true}
                      isActiveTurn={isMyTurn}
                      onPlayCard={handlePlayCard}
                      onMoveLayer={(cardId, targetFunction) => actionMutation.mutate({ type: "move_card_layer" as any, playerId: localPlayerId!, cardId, targetFunction })}
                    />
                  </div>

                  {/* Ongoing action card */}
                  {gameState.ongoingActionCard && (
                    <div className="bg-orange-50 dark:bg-orange-950/70 border-b border-orange-300/60 dark:border-orange-700/50 px-4 py-2 flex items-center gap-2">
                      <CircleDot className="w-3.5 h-3.5 text-orange-500 shrink-0" />
                      {gameState.ongoingActionCard.imageKey && (
                        <div className="w-8 h-11 rounded overflow-hidden border border-orange-400/40 shrink-0">
                          <img src={assetUrl(gameState.ongoingActionCard.imageKey)} alt={gameState.ongoingActionCard.name} className="w-full h-full object-cover" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold text-orange-700 dark:text-orange-400 leading-tight truncate">{gameState.ongoingActionCard.name}</div>
                        <div className="text-[10px] text-muted-foreground leading-snug line-clamp-1">{gameState.ongoingActionCard.cardText}</div>
                      </div>
                      {isMyTurn && gameState.phase === "play" && !gameState.pendingDecision && (() => {
                        const oid = (gameState.ongoingActionCard as any).baseId ?? gameState.ongoingActionCard!.id;
                        const ACTIVATABLE = ["hot_pile_bonus", "critical_mass", "nitrogen_boost", "rot_regrow"];
                        if (!ACTIVATABLE.includes(oid)) return null;
                        let canActivate = false;
                        if (oid === "hot_pile_bonus") canActivate = localPlayerFull.compostPile.filter(c => ((c as any).chosenFunction ?? (c as any).function) === "Decomposer").length >= 2;
                        else if (oid === "critical_mass") { const p = localPlayerFull.compostPile as any[]; canActivate = p.some((c1, i) => p.some((c2, j) => j !== i && c1.layer === c2.layer && c1.layer != null)); }
                        else if (oid === "nitrogen_boost") canActivate = localPlayerFull.hand.some(c => (c as any).function === "Nitrogen");
                        else if (oid === "rot_regrow") canActivate = localPlayerFull.hand.length >= 3;
                        const alreadyUsed = (gameState as any).ongoingBenefitUsedThisTurn === true;
                        return (
                          <button onClick={handleActivateOngoing} disabled={actionMutation.isPending || !canActivate || alreadyUsed}
                            className={cn("shrink-0 text-[10px] font-bold px-2 py-1 rounded-lg border transition-colors",
                              alreadyUsed ? "border-muted text-muted-foreground" :
                              canActivate ? "border-orange-400/60 text-orange-700 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/30 hover:bg-orange-100/50" :
                              "border-muted text-muted-foreground/50")}
                          >{alreadyUsed ? "Used ✓" : <><Zap className="w-2.5 h-2.5 inline mr-0.5" />Use</>}</button>
                        );
                      })()}
                    </div>
                  )}

                  {/* Hand */}
                  <div>
                    <div className="flex items-center px-4 py-1 border-b border-border/40">
                      <span className="text-xs font-medium text-muted-foreground">Hand <span className="font-mono text-[10px] text-foreground/40">{hand.length}/{localPlayerFull.maxHandSize}</span></span>
                      {isPlayPhase && <span className="ml-auto text-[11px] text-primary font-semibold">Click a card to play it</span>}
                    </div>
                    <div className="flex gap-3 px-4 py-3 overflow-x-auto flex-nowrap items-end">
                      {hand.length === 0 && <div className="py-2 text-muted-foreground/40 text-sm italic">No cards in hand</div>}
                      {hand.filter(c => c != null).map((card, idx) => {
                        const heroBlocked = card.type === "hero" && (gameState.heroPlayedThisTurn || gameState.actionPlayedThisTurn);
                        const actionBlocked = card.type === "action" && gameState.actionPlayedThisTurn;
                        const isPlayable = isPlayPhase && !heroBlocked && !actionBlocked;
                        const isBlocked = heroBlocked || actionBlocked;
                        const imageSrc = card.imageKey ? assetUrl(card.imageKey) : null;
                        return (
                          <motion.div
                            key={`${card.id}-${idx}`}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: isBlocked ? 0.4 : 1, y: 0 }}
                            transition={{ type: "spring", stiffness: 280, damping: 28 }}
                            onClick={() => !isBlocked && handleCardClick(card)}
                            className={cn(
                              "shrink-0 cursor-pointer rounded-xl overflow-hidden w-[176px] h-[256px]",
                              isPlayable && "ring-2 ring-primary/60 shadow-md shadow-primary/20 hover:shadow-lg hover:shadow-primary/30 hover:-translate-y-1 transition-transform",
                              isBlocked && "cursor-not-allowed",
                            )}
                          >
                            {imageSrc ? <img src={imageSrc} alt={card.name} className="w-full h-full object-cover" draggable={false} />
                              : <div className="w-full h-full"><GameCard card={card} size="md" hoverable={false} /></div>}
                          </motion.div>
                        );
                      })}
                    </div>
                  </div>
                </motion.div>
              )}
              </AnimatePresence>

              {/* Toggle bar — always visible */}
              <button
                className={cn(
                  "flex items-center justify-between px-5 py-2.5 border-t transition-colors group",
                  handPileOpen
                    ? "bg-card/95 backdrop-blur-md border-border hover:bg-muted/30"
                    : "bg-primary/90 backdrop-blur-md border-primary/60 hover:bg-primary text-primary-foreground"
                )}
                onClick={() => setHandPileOpen(o => !o)}
              >
                <div className="flex items-center gap-2.5">
                  <Layers className={cn("w-4 h-4", handPileOpen ? "text-muted-foreground" : "text-primary-foreground")} />
                  <span className={cn("text-sm font-bold", handPileOpen ? "text-foreground" : "text-primary-foreground")}>
                    {handPileOpen ? "Show Table" : "Show Hand & Pile"}
                  </span>
                  {!handPileOpen && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] bg-white/20 text-primary-foreground font-bold px-1.5 py-0.5 rounded-full">{hand.length} cards</span>
                      <span className="text-[11px] bg-white/20 text-primary-foreground font-bold px-1.5 py-0.5 rounded-full">{localPlayerFull.compostPile.length}/5 pile</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {!handPileOpen && isMyTurn && <span className="text-[11px] text-primary-foreground/80 font-semibold animate-pulse">Your turn!</span>}
                  {handPileOpen
                    ? <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    : <ChevronUp className="w-4 h-4 text-primary-foreground" />
                  }
                </div>
              </button>

              {/* Turn controls — always visible */}
              {gameState.phase !== "game_over" && (
                <div>
                  <AnimatePresence>
                    {isMyTurn && (
                      <motion.div key="turn-controls" initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 16, opacity: 0 }}
                        className="flex items-center justify-center gap-4 px-6 py-3 bg-primary/10 border-t border-primary/20 backdrop-blur-md"
                      >
                        {gameState.phase === "draw" && (
                          <Button size="lg" onClick={handleDrawCard} disabled={actionMutation.isPending} className="font-bold bg-primary hover:bg-primary/90 text-white rounded-xl shadow-md px-10">
                            {actionMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Drawing…</> : "Draw Card"}
                          </Button>
                        )}
                        {gameState.phase === "play" && (
                          <>
                            <span className="font-bold text-primary text-sm">Play a card or end your turn</span>
                            <Button size="lg" variant="secondary" onClick={handleEndTurn} disabled={actionMutation.isPending} className="font-bold rounded-xl shadow-md">
                              {actionMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />…</> : "End Turn"}
                            </Button>
                          </>
                        )}
                      </motion.div>
                    )}
                    {!isMyTurn && (
                      <motion.div key="waiting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="flex items-center justify-center gap-2 px-6 py-2.5 bg-muted/60 border-t border-border backdrop-blur-md"
                      >
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                        <span className="text-sm text-muted-foreground font-medium">Waiting for {currentPlayer.name}…</span>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

            </div>
          );
        })()}

        {/* ── MOBILE: unified hand + pile (hidden on md+) ── */}
        {(() => {
          const hand = localPlayerFull.hand;
          const pile = localPlayerFull.compostPile;
          const isPlayPhase = isMyTurn && gameState.phase === "play" && !gameState.pendingDecision;
          const CARD_W = 128;
          const scrollByCard = (dir: -1 | 1) => {
            handScrollRef.current?.scrollBy({ left: dir * (CARD_W + 12), behavior: "smooth" });
          };
          const categories = [
            { key: "moisture", label: "Moisture", borderClass: "border-blue-400", bgClass: "bg-blue-50 dark:bg-blue-950/30", headerClass: "bg-blue-100 text-blue-800", emptyDotClass: "bg-blue-200", match: (fn: string) => fn.toLowerCase().includes("moisture") },
            { key: "carbon", label: "Carbon", borderClass: "border-amber-400", bgClass: "bg-amber-50 dark:bg-amber-950/30", headerClass: "bg-amber-100 text-amber-800", emptyDotClass: "bg-amber-200", match: (fn: string) => fn.toLowerCase().includes("carbon") },
            { key: "decomposer", label: "Decomp.", borderClass: "border-orange-400", bgClass: "bg-orange-50 dark:bg-orange-950/30", headerClass: "bg-orange-100 text-orange-800", emptyDotClass: "bg-orange-200", match: (fn: string) => fn.toLowerCase().includes("decomp") || fn.toLowerCase().includes("fire") },
            { key: "nitrogen", label: "Nitrogen", borderClass: "border-lime-400", bgClass: "bg-lime-50 dark:bg-lime-950/30", headerClass: "bg-lime-100 text-lime-800", emptyDotClass: "bg-lime-200", match: (fn: string) => fn.toLowerCase().includes("nitrogen") },
            { key: "airflow", label: "Airflow", borderClass: "border-cyan-400", bgClass: "bg-cyan-50 dark:bg-cyan-950/30", headerClass: "bg-cyan-100 text-cyan-800", emptyDotClass: "bg-cyan-200", match: (fn: string) => fn.toLowerCase().includes("air") },
          ];
          const getEffFn = (c: Card) => (c as any).chosenFunction ?? c.function ?? "";
          return (
            <div className="md:hidden pointer-events-auto flex flex-col">

              {/* Collapsible: pile + ongoing + hand */}
              <AnimatePresence initial={false}>
              {handPileOpen && (
                <motion.div
                  key="mobile-panel"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: "easeInOut" }}
                  className="overflow-hidden"
                >

                  {/* Pile grid */}
                  <div className="bg-card/95 backdrop-blur-md border-t border-border">
                    <div className="flex items-center justify-between px-3 py-1 border-b border-border/40">
                      <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wide">My Compost Pile</span>
                      <span className="text-[11px] font-bold text-primary">{pile.length}/5</span>
                    </div>
                    <div className="px-2 pt-1.5 pb-2 grid grid-cols-5 gap-1.5">
                      {categories.map((cat) => {
                        const cards = pile.filter((c) => c != null && cat.match(getEffFn(c)));
                        const topCard = cards[cards.length - 1] ?? null;
                        const has = topCard !== null;
                        const imageSrc = topCard?.imageKey ? assetUrl(topCard.imageKey) : null;
                        const movableCards = !isMyTurn || !localPlayerId ? [] : cards.filter(card => {
                          const validFns: string[] = (card as any).alternateFunctions ?? [(card as any).function ?? ""];
                          if (validFns.length <= 1) return false;
                          const occupiedFns = new Set(pile.filter(c => c.id !== card.id).map(c => getEffFn(c as any)));
                          const currentFn = getEffFn(card as any);
                          return validFns.some(fn => fn !== currentFn && !occupiedFns.has(fn));
                        });
                        return (
                          <div key={cat.key} className={cn("rounded-lg border-2 flex flex-col overflow-hidden relative", has ? `${cat.borderClass} ${cat.bgClass}` : "border-dashed border-muted-foreground/20 bg-muted/10")}>
                            <div className={cn("px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide border-b flex items-center justify-between gap-0.5",
                              has ? `${cat.headerClass} border-current/20` : "bg-transparent text-muted-foreground/30 border-transparent")}>
                              <span className="truncate">{cat.label}</span>
                              {cards.length > 1 && <span className="shrink-0 text-[7px] font-bold opacity-60">×{cards.length}</span>}
                            </div>
                            <div className="flex-1 flex items-center justify-center" style={{ minHeight: 64 }}>
                              {has && topCard ? (
                                <div className="w-full h-full relative">
                                  {imageSrc ? <img src={imageSrc} alt={topCard.name} className="w-full h-full object-cover" />
                                    : <GameCard card={topCard} size="xs" hoverable={false} className="w-full h-full" />}
                                  {movableCards.some(c => c.id === topCard.id) && (
                                    <button onClick={() => actionMutation.mutate({ type: "move_card_layer" as any, playerId: localPlayerId!, cardId: topCard.id })}
                                      className="absolute bottom-0.5 right-0.5 bg-primary/90 text-white rounded-full p-0.5 shadow-md active:scale-90 z-10"
                                    ><MoveRight className="w-2 h-2" /></button>
                                  )}
                                </div>
                              ) : <div className={cn("w-2 h-2 rounded-full", cat.emptyDotClass, "opacity-40")} />}
                            </div>
                            {has && topCard && (
                              <div className="px-0.5 py-0.5 text-[7px] font-semibold text-center leading-tight text-foreground/70 bg-background/30 truncate">{topCard.name}</div>
                            )}
                            {movableCards.filter(c => c.id !== topCard?.id).map(card => (
                              <button key={card.id} onClick={() => actionMutation.mutate({ type: "move_card_layer" as any, playerId: localPlayerId!, cardId: card.id })}
                                className="w-full flex items-center justify-center gap-0.5 px-0.5 py-0.5 bg-primary/10 border-t border-primary/20 text-primary active:bg-primary/20 transition-colors"
                              ><MoveRight className="w-2 h-2 shrink-0" /><span className="text-[7px] font-bold truncate">{card.name}</span></button>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Ongoing action card */}
                  {gameState.ongoingActionCard && (
                    <div className="bg-orange-50 dark:bg-orange-950/70 border-t border-orange-300/60 dark:border-orange-700/50 px-3 py-2 flex items-center gap-2">
                      <CircleDot className="w-3.5 h-3.5 text-orange-500 shrink-0" />
                      {gameState.ongoingActionCard.imageKey && (
                        <div className="w-8 h-11 rounded overflow-hidden border border-orange-400/40 shrink-0">
                          <img src={assetUrl(gameState.ongoingActionCard.imageKey)} alt={gameState.ongoingActionCard.name} className="w-full h-full object-cover" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold text-orange-700 dark:text-orange-400 leading-tight truncate">{gameState.ongoingActionCard.name}</div>
                        <div className="text-[10px] text-muted-foreground leading-snug line-clamp-2">{gameState.ongoingActionCard.cardText}</div>
                      </div>
                      {isMyTurn && gameState.phase === "play" && !gameState.pendingDecision && (() => {
                        const oid = (gameState.ongoingActionCard as any).baseId ?? gameState.ongoingActionCard!.id;
                        const ACTIVATABLE = ["hot_pile_bonus", "critical_mass", "nitrogen_boost", "rot_regrow"];
                        if (!ACTIVATABLE.includes(oid)) return null;
                        let canActivate = false;
                        if (oid === "hot_pile_bonus") canActivate = localPlayerFull.compostPile.filter(c => ((c as any).chosenFunction ?? (c as any).function) === "Decomposer").length >= 2;
                        else if (oid === "critical_mass") { const p = localPlayerFull.compostPile as any[]; canActivate = p.some((c1, i) => p.some((c2, j) => j !== i && c1.layer === c2.layer && c1.layer != null)); }
                        else if (oid === "nitrogen_boost") canActivate = localPlayerFull.hand.some(c => (c as any).function === "Nitrogen");
                        else if (oid === "rot_regrow") canActivate = localPlayerFull.hand.length >= 3;
                        const alreadyUsed = (gameState as any).ongoingBenefitUsedThisTurn === true;
                        return (
                          <button onClick={handleActivateOngoing} disabled={actionMutation.isPending || !canActivate || alreadyUsed}
                            className={cn("shrink-0 text-[10px] font-bold px-2 py-1 rounded-lg border transition-colors",
                              alreadyUsed ? "border-muted text-muted-foreground" :
                              canActivate ? "border-orange-400/60 text-orange-700 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/30 active:scale-95" :
                              "border-muted text-muted-foreground/50")}
                          >{alreadyUsed ? "Used ✓" : <><Zap className="w-2.5 h-2.5 inline mr-0.5" />Use</>}</button>
                        );
                      })()}
                    </div>
                  )}

                  {/* Hand */}
                  <div className="bg-card/90 backdrop-blur-md border-t border-border/60">
                    <div className="flex items-center justify-between px-3 py-1 border-b border-border/40">
                      <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wide">Hand · {hand.length}/{localPlayerFull.maxHandSize}</span>
                      {isMyTurn && <span className="text-[11px] font-semibold text-primary">{gameState.phase === "draw" ? "Draw first" : isPlayPhase ? "Tap to play" : ""}</span>}
                    </div>
                    <div className="relative flex items-center gap-1 px-2 py-2">
                      <button onClick={() => scrollByCard(-1)} className="shrink-0 w-7 h-7 rounded-full border border-border bg-background/80 flex items-center justify-center shadow-sm z-10">
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </button>
                      <div ref={handScrollRef} className="flex gap-3 overflow-x-auto flex-1 scroll-smooth" style={{ scrollbarWidth: "none" }}>
                        {hand.length === 0 && <div className="flex-1 flex items-center justify-center py-4 text-muted-foreground/50 text-sm italic">No cards in hand</div>}
                        {hand.filter(c => c != null).map((card, idx) => {
                          const heroBlocked = card.type === "hero" && (gameState.heroPlayedThisTurn || gameState.actionPlayedThisTurn);
                          const actionBlocked = card.type === "action" && gameState.actionPlayedThisTurn;
                          const isBlocked = heroBlocked || actionBlocked;
                          const isPlayable = isPlayPhase && !isBlocked;
                          const imageSrc = card.imageKey ? assetUrl(card.imageKey) : null;
                          return (
                            <motion.div key={`${card.id}-${idx}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: isBlocked ? 0.45 : 1, y: 0 }} transition={{ delay: idx * 0.03 }} className="shrink-0 flex flex-col items-center gap-1">
                              <div onClick={() => !isBlocked && handleCardClick(card)}
                                className={cn("w-28 h-44 rounded-xl overflow-hidden border-2 shadow-md transition-all",
                                  isPlayable ? "border-primary/70 cursor-pointer active:scale-95 shadow-primary/20" : "border-border",
                                  isBlocked && "cursor-not-allowed")}
                              >
                                {imageSrc ? <img src={imageSrc} alt={card.name} className="w-full h-full object-cover" />
                                  : <GameCard card={card} size="md" hoverable={false} className="!w-28 !h-44" />}
                              </div>
                              {isPlayable && <button onClick={() => handleCardClick(card)} className="text-[10px] bg-primary text-primary-foreground rounded-full px-3 py-0.5 font-bold shadow-sm">Play</button>}
                              {isBlocked && <span className="text-[9px] text-destructive font-bold">{heroBlocked ? "hero first" : "1 action/turn"}</span>}
                            </motion.div>
                          );
                        })}
                      </div>
                      <button onClick={() => scrollByCard(1)} className="shrink-0 w-7 h-7 rounded-full border border-border bg-background/80 flex items-center justify-center shadow-sm z-10">
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                </motion.div>
              )}
              </AnimatePresence>

              {/* Toggle bar — always visible */}
              <button
                className={cn(
                  "w-full flex items-center justify-between px-4 py-3 border-t transition-colors",
                  handPileOpen
                    ? "bg-card/95 backdrop-blur-md border-border active:bg-muted/30"
                    : "bg-primary/90 backdrop-blur-md border-primary/60 active:bg-primary"
                )}
                onClick={() => setHandPileOpen(o => !o)}
              >
                <div className="flex items-center gap-2">
                  <Layers className={cn("w-4 h-4", handPileOpen ? "text-muted-foreground" : "text-primary-foreground")} />
                  <span className={cn("text-sm font-bold", handPileOpen ? "text-foreground" : "text-primary-foreground")}>
                    {handPileOpen ? "Show Table" : "Show Hand & Pile"}
                  </span>
                  {!handPileOpen && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] bg-white/20 text-primary-foreground font-semibold px-1.5 py-0.5 rounded-full">{hand.length} cards</span>
                      <span className="text-[11px] bg-white/20 text-primary-foreground font-semibold px-1.5 py-0.5 rounded-full">{pile.length}/5 pile</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {!handPileOpen && isMyTurn && <span className="text-[11px] text-primary-foreground/80 font-semibold animate-pulse">Your turn!</span>}
                  {handPileOpen
                    ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                    : <ChevronUp className="w-4 h-4 text-primary-foreground" />
                  }
                </div>
              </button>

              {/* Turn controls — always visible */}
              {gameState.phase !== "game_over" && isMyTurn && (
                <div className="bg-primary/10 border-t border-primary/20 px-4 py-2.5 flex items-center justify-center gap-3">
                  {gameState.phase === "draw" && (
                    <Button size="default" onClick={handleDrawCard} disabled={actionMutation.isPending} className="font-bold bg-primary hover:bg-primary/90 text-white rounded-xl shadow-md px-8 w-full">
                      {actionMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Drawing…</> : "Draw Card"}
                    </Button>
                  )}
                  {gameState.phase === "play" && (
                    <Button size="default" variant="secondary" onClick={handleEndTurn} disabled={actionMutation.isPending} className="font-bold rounded-xl shadow-md w-full">
                      {actionMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />…</> : "End Turn"}
                    </Button>
                  )}
                </div>
              )}
              {gameState.phase !== "game_over" && !isMyTurn && (
                <div className="bg-muted/60 border-t border-border px-4 py-2 flex items-center justify-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                  <span className="text-sm text-muted-foreground font-medium">Waiting for {currentPlayer.name}…</span>
                </div>
              )}

            </div>
          );
        })()}
      </div>


      {/* PLAY CARD CONFIRMATION MODAL */}
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
              initial={{ scale: 0.85, y: 40 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.85, y: 40 }}
              transition={{ type: "spring", bounce: 0.35 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-card rounded-3xl shadow-2xl w-full max-w-md overflow-hidden relative"
            >
              {/* Header */}
              <div className={cn(
                "px-6 py-4 border-b border-border flex items-center justify-between",
                confirmCard.type === "hero"
                  ? "bg-gradient-to-r from-green-600/20 via-green-500/10 to-emerald-400/10"
                  : confirmCard.effectType === "ongoing"
                    ? "bg-gradient-to-r from-orange-500/20 via-orange-400/10 to-yellow-400/10"
                    : "bg-gradient-to-r from-blue-500/20 via-blue-400/10 to-cyan-400/10"
              )}>
                <div className="flex items-center gap-3">
                  {confirmCard.type === "hero" ? (
                    <Leaf className="w-5 h-5 text-green-600" />
                  ) : confirmCard.effectType === "ongoing" ? (
                    <CircleDot className="w-5 h-5 text-orange-500" />
                  ) : (
                    <Zap className="w-5 h-5 text-blue-500" />
                  )}
                  <div>
                    <div className="font-display font-bold text-lg text-foreground leading-tight">{confirmCard.name}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={cn(
                        "text-[10px] font-bold uppercase px-2 py-0.5 rounded-full",
                        confirmCard.type === "hero"
                          ? "bg-green-100 text-green-800"
                          : "bg-blue-100 text-blue-800"
                      )}>
                        {confirmCard.type === "hero" ? "Hero" : "Action"}
                      </span>
                      <span className={cn(
                        "text-[10px] font-bold uppercase px-2 py-0.5 rounded-full",
                        confirmCard.effectType === "ongoing"
                          ? "bg-orange-100 text-orange-800"
                          : "bg-slate-100 text-slate-700"
                      )}>
                        {confirmCard.effectType === "ongoing" ? "⬤ Ongoing" : "⚡ Instant"}
                      </span>
                      {confirmCard.function && (
                        <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-secondary/20 text-secondary-foreground">
                          {confirmCard.function}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <button onClick={() => setConfirmCard(null)} className="text-muted-foreground hover:text-foreground transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Card preview + effect */}
              <div className="p-6 flex gap-5 items-start">
                {/* Card image or placeholder */}
                <div className="shrink-0">
                  {confirmCard.imageKey ? (
                    <div className="w-24 h-36 rounded-xl overflow-hidden shadow-lg border-2 border-border">
                      <img
                        src={assetUrl(confirmCard.imageKey)}
                        alt={confirmCard.name}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  ) : (
                    <GameCard card={confirmCard} size="sm" hoverable={false} />
                  )}
                </div>

                {/* Effect text */}
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Effect</div>
                  <div className="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800/40 rounded-xl p-3 text-sm text-foreground leading-relaxed font-medium">
                    {confirmCard.cardText}
                  </div>
                  {confirmCard.type === "hero" && (
                    <div className="mt-3 text-xs text-muted-foreground bg-green-50 dark:bg-green-950/20 border border-green-200/50 rounded-lg p-2">
                      This hero will be placed in your <strong>{confirmCard.function}</strong> slot.
                    </div>
                  )}
                  {confirmCard.type === "action" && confirmCard.effectType === "ongoing" && (
                    <div className="mt-3 text-xs text-muted-foreground bg-orange-50 dark:bg-orange-950/20 border border-orange-200/50 rounded-lg p-2">
                      This card will occupy the <strong>Ongoing Action</strong> slot and stay in effect until replaced or removed.
                    </div>
                  )}
                  {confirmCard.type === "action" && confirmCard.effectType === "instant" && (
                    <div className="mt-3 text-xs text-muted-foreground bg-blue-50 dark:bg-blue-950/20 border border-blue-200/50 rounded-lg p-2">
                      This card resolves immediately, then goes to the discard pile.
                    </div>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="px-6 pb-6 flex gap-3">
                <Button
                  className="flex-1 font-bold text-base"
                  onClick={() => handlePlayCard(confirmCard.id)}
                  disabled={actionMutation.isPending}
                >
                  {actionMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Play Card
                </Button>
                <Button variant="outline" className="flex-1 font-bold text-base" onClick={() => setConfirmCard(null)}>
                  Cancel
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* OPPONENT PILE MODAL */}
      {viewingOpponent && (
        <OpponentPileModal
          player={viewingOpponent}
          onClose={() => setViewingOpponent(null)}
        />
      )}

      {/* DECISION MODAL OVERLAY — never show for bot players.
          The pending decision may belong to a non-current player (e.g. Worm Party,
          Soggy Pile cascades). In facilitated mode the modal is keyed ONLY off the
          decision owner's playerId — deliberately NOT gated on isMyTurn — so the
          token-owning decision player can act even when it is not their turn. */}
      {gameState.pendingDecision &&
        (isFacilitated
          ? gameState.pendingDecision.playerId === localPlayerId && !localPlayerFull?.isBot
          : isMyTurn && !currentPlayer.isBot) && (
        <DecisionModal 
          decision={gameState.pendingDecision}
          gameState={gameState}
          onResolve={handleResolveDecision}
          stepInfo={isFacilitated
            ? getDecisionStepInfo(gameState.pendingDecision.type, gameState.pendingDecision.meta)
            : null}
        />
      )}

      {/* FACILITATED: effect announcement broadcast to everyone */}
      {isFacilitated && (
        <EffectAnnouncementOverlay effect={gameState.lastEffect} />
      )}

      {/* FACILITATED: waiting state — someone else is making a choice */}
      {isFacilitated &&
        gameState.pendingDecision &&
        gameState.pendingDecision.playerId !== localPlayerId &&
        !gameState.players.find(p => p.id === gameState.pendingDecision!.playerId)?.isBot && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] max-w-[92vw]"
        >
          <div className="bg-card/97 backdrop-blur-lg border border-border shadow-2xl rounded-2xl px-5 py-3 flex items-center gap-3">
            <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-bold text-foreground">
                {gameState.players.find(p => p.id === gameState.pendingDecision!.playerId)?.name ?? "Someone"} is choosing…
              </div>
              <div className="text-xs text-muted-foreground leading-snug truncate">
                {gameState.pendingDecision.prompt}
              </div>
            </div>
          </div>
        </motion.div>
      )}

      {/* PASS DEVICE OVERLAY — shown when the current player changes in Pass & Play */}
      <AnimatePresence>
        {passScreen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 backdrop-blur-md"
          >
            <motion.div
              initial={{ scale: 0.85, y: 30 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: "spring", bounce: 0.4 }}
              className="bg-card w-full max-w-sm mx-4 rounded-3xl shadow-2xl p-8 text-center border border-border"
            >
              <div className="w-20 h-20 rounded-full bg-primary/10 border-4 border-primary/30 flex items-center justify-center mx-auto mb-5">
                <Leaf className="w-10 h-10 text-primary" />
              </div>
              <p className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-1">Pass the device to</p>
              <h2 className="text-4xl font-display font-bold text-foreground mb-3">{passScreen.name}</h2>
              <p className="text-muted-foreground text-sm mb-7">
                You have <strong className="text-foreground">{passScreen.cardCount}</strong> card{passScreen.cardCount !== 1 ? "s" : ""} from your last turn — they're waiting for you!
              </p>
              <Button
                size="lg"
                className="w-full font-bold text-lg rounded-2xl"
                onClick={() => setPassScreen(null)}
              >
                Reveal My Hand
              </Button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* DISCARD PILE MODAL */}
      <AnimatePresence>
        {viewingDiscard && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[55] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
            onClick={() => setViewingDiscard(false)}
          >
            <motion.div
              initial={{ y: 60, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 60, opacity: 0 }}
              transition={{ type: "spring", bounce: 0.25 }}
              className="bg-card w-full max-w-2xl rounded-3xl shadow-2xl border border-border overflow-hidden max-h-[85vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
                <div>
                  <h3 className="font-display font-bold text-xl text-foreground">Discard Pile</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">{gameState.discardPile.length} card{gameState.discardPile.length !== 1 ? "s" : ""} — most recent first</p>
                </div>
                <button onClick={() => setViewingDiscard(false)} className="text-muted-foreground hover:text-foreground transition-colors p-1">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Scrollable card grid */}
              <div className="overflow-y-auto p-5 flex-1">
                {gameState.discardPile.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground/40">
                    <RefreshCcw className="w-12 h-12 mb-3" />
                    <p className="font-bold">Discard pile is empty</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                    {[...gameState.discardPile].reverse().map((card, idx) => {
                      const imageSrc = card.imageKey
                        ? assetUrl(card.imageKey)
                        : null;
                      return (
                        <div key={`${card.id}-${idx}`} className="flex flex-col gap-2 items-center">
                          {imageSrc ? (
                            <div className="w-full aspect-[2/3] rounded-xl overflow-hidden border-2 border-border shadow-sm">
                              <img src={imageSrc} alt={card.name} className="w-full h-full object-cover" />
                            </div>
                          ) : (
                            <GameCard card={card} size="sm" hoverable={false} />
                          )}
                          <div className="text-center">
                            <div className="font-bold text-xs text-foreground leading-tight">{card.name}</div>
                            <div className="flex items-center justify-center gap-1 mt-0.5 flex-wrap">
                              <span className={cn(
                                "text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full",
                                card.type === "hero" ? "bg-green-100 text-green-800" : "bg-blue-100 text-blue-800"
                              )}>
                                {card.type}
                              </span>
                              {card.function && (
                                <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-secondary/20 text-secondary-foreground">
                                  {card.function}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

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
              <img
                src={compostHeroesLogo}
                alt="Compost Heroes"
                className="w-56 mx-auto mb-4 drop-shadow-xl"
                draggable={false}
              />
              {localPlayerId === gameState.winner ? (
                <>
                  <h2 className="text-4xl font-display font-bold text-primary mb-2">You're a Compost Hero!</h2>
                  <p className="text-xl text-muted-foreground mb-8">
                    Your pile is complete — well composted!
                  </p>
                </>
              ) : (
                <>
                  <h2 className="text-4xl font-display font-bold text-foreground mb-2">
                    <strong className="text-primary">{gameState.players.find(p => p.id === gameState.winner)?.name ?? "Someone"}</strong> is a Compost Hero!
                  </h2>
                  <p className="text-xl text-muted-foreground mb-8">
                    Their compost pile is complete!
                  </p>
                </>
              )}
              
              <div className="flex flex-col sm:flex-row justify-center gap-3">
                <Button
                  size="lg"
                  className="font-bold text-lg"
                  disabled={actionMutation.isPending}
                  onClick={() => {
                    const pid = localPlayerId ?? gameState.players[0]?.id;
                    if (pid) actionMutation.mutate({ type: "reset_game" as any, playerId: pid });
                  }}
                >
                  {actionMutation.isPending ? (
                    <><Loader2 className="w-5 h-5 mr-2 animate-spin" />Resetting…</>
                  ) : (
                    "Play Again"
                  )}
                </Button>
                <Button size="lg" variant="outline" className="font-bold text-lg" onClick={() => setLocation("/")}>
                  Return to Lobby
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>

    </>
  );
}
