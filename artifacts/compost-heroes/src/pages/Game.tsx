import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import confetti from "canvas-confetti";
import { assetUrl } from "@/lib/assetUrl";
import { useGameState, useGameAction, useClaimSlot, useGameSse, useJoinRoom, getStoredToken } from "@/hooks/use-game";
import { WaitingRoom } from "@/components/WaitingRoom";
import { PlayerMat } from "@/components/PlayerMat";
import { GameCard } from "@/components/GameCard";
import { DecisionModal } from "@/components/DecisionModal";
import { OpponentPileModal } from "@/components/OpponentPileModal";
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
  Lock,
  GalleryHorizontal,
  LayoutGrid,
} from "lucide-react";
import { cn } from "@/lib/utils";

export default function Game() {
  const { gameId } = useParams();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  // ── Token-based identity for online multiplayer ──
  // 1. Use any token already in localStorage (so returning players get filtered state immediately)
  const storedToken = gameId ? getStoredToken(gameId) : null;

  // 2. Fetch game state (pass stored token so online games are filtered from first load)
  const { data: gameState, isLoading, error } = useGameState(gameId || null, storedToken);
  const isOnline = gameState?.mode === "online";
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
  useGameSse(gameId || null, localToken, isOnline && !!localToken, handleKicked);

  // 5. Join-form state (for waiting-room newcomers)
  const joinRoom = useJoinRoom(gameId || null);
  const [joinName, setJoinName] = useState("");
  const [joinRoomPassword, setJoinRoomPassword] = useState("");

  const actionMutation = useGameAction(gameId || "", isOnline ? localToken : null, {
    onError: (msg) => toast({ title: "Action failed", description: msg, variant: "destructive" }),
  });

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

  // Hand view mode: fan | carousel | grid (persisted in localStorage)
  type HandView = "fan" | "carousel" | "grid";
  const [handView, setHandView] = useState<HandView>(() => {
    try { return (localStorage.getItem("compost_hand_view") as HandView) || "fan"; }
    catch { return "fan"; }
  });
  const changeHandView = (v: HandView) => {
    setHandView(v);
    try { localStorage.setItem("compost_hand_view", v); } catch {}
  };

  // Hand navigation (used in carousel and grid focus)
  const [handFocusIdx, setHandFocusIdx] = useState(0);

  // Rolodex wheel state — tracks how far the wheel has rotated (degrees)
  const [wheelAngle, setWheelAngle] = useState(0);
  const wheelDragRef = useRef<{ startX: number; startAngle: number } | null>(null);
  const wasDraggingRef = useRef(false);

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
      setPassScreen({ name: newPlayer.name, cardCount: newPlayer.hand.length });
    }
    prevPlayerIndexRef.current = idx;
  }, [gameState?.currentPlayerIndex, isOnline]);


  // Clamp handFocusIdx when hand size changes
  useEffect(() => {
    if (!gameState) return;
    const len = gameState.players.find(p => p.id === localPlayerId)?.hand.length ?? 0;
    setHandFocusIdx(prev => Math.max(0, Math.min(prev, len - 1)));
  }, [gameState?.players, localPlayerId]);

  // Clamp wheelAngle when hand size changes
  useEffect(() => {
    if (!gameState) return;
    const len = gameState.players.find(p => p.id === localPlayerId)?.hand.length ?? 0;
    if (len === 0) { setWheelAngle(0); return; }
    const spread = Math.max(8, Math.min(22, 130 / len));
    setWheelAngle(a => Math.max(0, Math.min((len - 1) * spread, a)));
  }, [gameState?.players, localPlayerId]);

  // Announce new log entries as on-screen banners
  useEffect(() => {
    if (!gameState?.log) return;
    const logLen = gameState.log.length;
    if (logLen > prevLogLength.current) {
      const latest = gameState.log[logLen - 1];
      prevLogLength.current = logLen;
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
    if (!isMyTurn || !localPlayerId) return;
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
    // Block second hero
    if (card.type === "hero" && gameState?.heroPlayedThisTurn) {
      toast({ title: "One hero per turn", description: "You've already played a hero card this turn.", variant: "destructive" });
      return;
    }
    // Block second action card when a hero was played this turn
    if (card.type === "action" && gameState?.heroPlayedThisTurn && gameState?.actionPlayedThisTurn) {
      toast({ title: "One action after a hero", description: "After playing a hero card you may only play one action card.", variant: "destructive" });
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
    <div className="min-h-screen bg-background game-table-pattern flex flex-col overflow-hidden text-foreground">
      {/* Background Decor */}
      <div className="fixed inset-0 pointer-events-none opacity-[0.03] z-0 mix-blend-multiply">
         <img src={`${import.meta.env.BASE_URL}images/wood-bg.png`} className="w-full h-full object-cover" alt="" />
      </div>

      {/* Online mode badge */}
      {isOnline && (
        <div className="fixed top-3 right-3 z-50 flex items-center gap-1.5 bg-green-500/15 border border-green-500/30 text-green-600 px-2.5 py-1 rounded-full text-xs font-bold backdrop-blur-md">
          <Wifi className="w-3 h-3" />
          Online
          {claim?.playerName && <span className="opacity-70">· {claim.playerName}</span>}
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
      <div className="relative z-10 flex-none p-4 pb-0 flex justify-center gap-4 overflow-x-auto">
        {opponents.map(opp => (
          <PlayerMat 
            key={opp.id} 
            player={opp} 
            isCurrentPlayer={opp.id === currentPlayer.id}
            isLocalUser={false}
            isActiveTurn={opp.id === currentPlayer.id}
            onViewPile={() => setViewingOpponent(opp)}
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

          {/* THE CHALLENGE zone — Ongoing Action Card + Hero Effects */}
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
                        (gameState.ongoingActionCard.id === "rot_regrow" || gameState.ongoingActionCard.id === "nitrogen_boost") && (() => {
                          const oid = gameState.ongoingActionCard!.id;
                          const canActivate = oid === "rot_regrow"
                            ? localPlayerFull.hand.length >= 3
                            : localPlayerFull.hand.some(c => (c as any).function === "Nitrogen");
                          const hint = oid === "rot_regrow"
                            ? (canActivate ? "Discard 3 cards then take 1 from discard" : "Need at least 3 cards in hand")
                            : (canActivate ? "Discard 1 Nitrogen card to draw 2" : "Need a Nitrogen card in hand");
                          return (
                            <Button
                              size="sm"
                              variant="outline"
                              className="mt-2 w-full text-xs font-bold border-orange-400/60 text-orange-700 hover:bg-orange-50 dark:hover:bg-orange-950/30 h-7"
                              onClick={handleActivateOngoing}
                              disabled={actionMutation.isPending || !canActivate}
                              title={hint}
                            >
                              <Zap className="w-3 h-3 mr-1" />
                              Activate Effect
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
            {gameState.activeModifiers.filter(m => !gameState.ongoingActionCard || m.cardId !== gameState.ongoingActionCard.id).length > 0 && (
              <div className="bg-card/90 backdrop-blur-md rounded-2xl border shadow-xl overflow-hidden">
                <div className="bg-gradient-to-r from-primary/20 via-primary/10 to-secondary/20 px-4 py-2 border-b border-border/50 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-primary" />
                  <span className="font-display font-bold text-sm tracking-widest uppercase text-foreground">Hero Effects</span>
                </div>
                <div className="p-3 flex flex-wrap gap-2 items-start">
                  {gameState.activeModifiers
                    .filter(m => !gameState.ongoingActionCard || m.cardId !== gameState.ongoingActionCard.id)
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
      <div className="relative z-20 pb-52">
        <PlayerMat 
          player={localPlayerFull} 
          isCurrentPlayer={isMyTurn}
          isLocalUser={true}
          isActiveTurn={isMyTurn}
          onPlayCard={handlePlayCard}
          onMoveLayer={(cardId) => actionMutation.mutate({ type: "move_card_layer" as any, playerId: localPlayerId!, cardId })}
        />
      </div>

      {/* HAND OVERLAY — fixed at screen bottom, with view-mode toggle */}
      <div className="fixed bottom-0 inset-x-0 z-30">

        {/* Toggle bar — always visible */}
        <div className="flex items-center justify-between px-3 py-1.5 bg-card/95 backdrop-blur-md border-t border-border">
          <span className="text-xs font-medium text-muted-foreground">
            Hand&nbsp;
            <span className="font-mono text-[10px] text-foreground/40">
              {localPlayerFull.hand.length}/{localPlayerFull.maxHandSize}
            </span>
          </span>
          <div className="flex gap-1">
            {(["fan", "carousel", "grid"] as const).map((v) => (
              <button
                key={v}
                onClick={() => changeHandView(v)}
                title={{ fan: "Fan", carousel: "Card detail", grid: "All cards" }[v]}
                className={cn(
                  "w-8 h-8 rounded-lg flex items-center justify-center transition-all",
                  handView === v
                    ? "bg-primary text-primary-foreground shadow"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {v === "fan" && <Layers className="w-4 h-4" />}
                {v === "carousel" && <GalleryHorizontal className="w-4 h-4" />}
                {v === "grid" && <LayoutGrid className="w-4 h-4" />}
              </button>
            ))}
          </div>
        </div>

        {/* ── FAN VIEW (Rolodex wheel) ── */}
        {handView === "fan" && (() => {
          const hand = localPlayerFull.hand;
          const total = hand.length;
          const PIVOT_R = 300;
          const PIVOT_BEYOND = 300;   // pivot sits exactly below the container bottom → card bottoms rest there at angle=0
          const CONTAINER_H = 190;
          const CARD_W = 112;
          const spreadDeg = total <= 1 ? 0 : Math.max(8, Math.min(22, 130 / total));
          const clampedAngle = Math.max(0, Math.min((total - 1) * spreadDeg, wheelAngle));
          const focusedIdx = Math.round(clampedAngle / (spreadDeg || 1));

          const handleWheelPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            wheelDragRef.current = { startX: e.clientX, startAngle: clampedAngle };
            wasDraggingRef.current = false;
          };
          const handleWheelPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
            if (!wheelDragRef.current) return;
            const deltaX = e.clientX - wheelDragRef.current.startX;
            if (Math.abs(deltaX) > 5) wasDraggingRef.current = true;
            const TOUCH_PX_PER_DEG = 8;
            const raw = wheelDragRef.current.startAngle - deltaX / TOUCH_PX_PER_DEG;
            setWheelAngle(Math.max(0, Math.min((total - 1) * spreadDeg, raw)));
          };
          const handleWheelPointerUp = () => {
            wheelDragRef.current = null;
            if (spreadDeg === 0) return;
            setWheelAngle(a => {
              const snapped = Math.round(a / spreadDeg) * spreadDeg;
              return Math.max(0, Math.min((total - 1) * spreadDeg, snapped));
            });
          };

          return (
            <div
              className="relative overflow-visible bg-card/30 backdrop-blur-sm touch-none select-none"
              style={{ height: CONTAINER_H }}
              onPointerDown={handleWheelPointerDown}
              onPointerMove={handleWheelPointerMove}
              onPointerUp={handleWheelPointerUp}
              onPointerCancel={handleWheelPointerUp}
            >
              {hand.length === 0 && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-muted-foreground/40 text-sm italic">No cards in hand</div>
              )}
              {hand.map((card, idx) => {
                const slotAngle = idx * spreadDeg - clampedAngle;
                const rad = (slotAngle * Math.PI) / 180;
                const cardX = PIVOT_R * Math.sin(rad) - CARD_W / 2;
                const cardY = -(PIVOT_R * Math.cos(rad) - PIVOT_BEYOND);
                const progress = Math.max(0, Math.cos(rad));
                const scale = 0.52 + 0.48 * progress;
                const opacity = 0.22 + 0.78 * progress;
                const isFocused = idx === focusedIdx;

                const isPlayPhase = isMyTurn && gameState.phase === "play" && !gameState.pendingDecision;
                const heroBlocked = card.type === "hero" && gameState.heroPlayedThisTurn;
                const actionBlocked = card.type === "action" && gameState.heroPlayedThisTurn && gameState.actionPlayedThisTurn;
                const isPlayable = isPlayPhase && !heroBlocked && !actionBlocked;
                const isBlocked = heroBlocked || actionBlocked;
                const imageSrc = card.imageKey ? assetUrl(card.imageKey) : null;

                return (
                  <motion.div
                    key={card.id}
                    className="absolute bottom-0 pointer-events-auto"
                    style={{ left: "50%" }}
                    animate={{
                      x: cardX,
                      y: cardY,
                      rotate: slotAngle,
                      scale: isBlocked ? scale * 0.82 : scale,
                      opacity: isBlocked ? opacity * 0.5 : opacity,
                      zIndex: isFocused ? 20 : Math.max(1, 15 - Math.abs(Math.round(slotAngle / (spreadDeg || 1)))),
                    }}
                    transition={{ type: "spring", stiffness: 380, damping: 32, mass: 0.85 }}
                    onClick={() => {
                      if (wasDraggingRef.current) { wasDraggingRef.current = false; return; }
                      if (!isFocused) {
                        setWheelAngle(idx * spreadDeg);
                      } else {
                        handleCardClick(card);
                      }
                    }}
                  >
                    <div className="relative">
                      {imageSrc ? (
                        <div className={cn(
                          "w-28 h-40 rounded-xl overflow-hidden shadow-xl border-2 transition-colors",
                          isFocused ? "border-primary/70 shadow-primary/25" : "border-white/20",
                          !isBlocked && "cursor-pointer",
                          isBlocked && "cursor-not-allowed",
                        )}>
                          <img src={imageSrc} alt={card.name} className="w-full h-full object-cover" />
                        </div>
                      ) : (
                        <GameCard
                          card={card}
                          isFaceDown={false}
                          hoverable={false}
                          className={cn(
                            isFocused && "shadow-primary/25",
                            !isBlocked && "cursor-pointer",
                            isBlocked && "cursor-not-allowed",
                          )}
                        />
                      )}
                      {isFocused && isPlayable && (
                        <div className="absolute -top-7 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-[10px] font-bold px-2 py-0.5 rounded-full shadow-lg whitespace-nowrap pointer-events-none z-50">
                          Tap to play
                        </div>
                      )}
                      {isFocused && isBlocked && (
                        <div className="absolute -top-7 left-1/2 -translate-x-1/2 bg-destructive text-destructive-foreground text-[10px] font-bold px-2 py-0.5 rounded-full shadow-lg whitespace-nowrap pointer-events-none z-50">
                          {heroBlocked ? "1 hero/turn" : "1 action after hero"}
                        </div>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          );
        })()}

        {/* ── CAROUSEL VIEW ── */}
        {handView === "carousel" && (
          <div className="bg-card/95 backdrop-blur-md">
            {localPlayerFull.hand.length === 0 ? (
              <div className="flex items-center justify-center h-16 text-muted-foreground/50 text-sm italic">No cards in hand</div>
            ) : (() => {
              const card = localPlayerFull.hand[handFocusIdx] ?? localPlayerFull.hand[0];
              const isPlayPhase = isMyTurn && gameState.phase === "play" && !gameState.pendingDecision;
              const heroBlocked = card.type === "hero" && gameState.heroPlayedThisTurn;
              const actionBlocked = card.type === "action" && gameState.heroPlayedThisTurn && gameState.actionPlayedThisTurn;
              const isPlayable = isPlayPhase && !heroBlocked && !actionBlocked;
              const imageSrc = card.imageKey ? assetUrl(card.imageKey) : null;
              return (
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    className="shrink-0 w-9 h-9 rounded-full bg-background/80 border border-border flex items-center justify-center disabled:opacity-30 active:scale-95 transition-transform"
                    disabled={handFocusIdx === 0}
                    onClick={() => setHandFocusIdx(i => i - 1)}
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>

                  <div className="flex-1 flex items-center gap-3 min-w-0">
                    <motion.div
                      key={card.id}
                      initial={{ opacity: 0, scale: 0.88, x: 16 }}
                      animate={{ opacity: 1, scale: 1, x: 0 }}
                      className={cn(
                        "shrink-0 w-16 h-24 rounded-xl overflow-hidden shadow-lg border-2 cursor-pointer transition-all",
                        isPlayable ? "border-primary shadow-primary/20" : "border-border/60",
                        (heroBlocked || actionBlocked) && "opacity-50 cursor-not-allowed"
                      )}
                      onClick={(!heroBlocked && !actionBlocked) ? () => handleCardClick(card) : undefined}
                    >
                      {imageSrc
                        ? <img src={imageSrc} alt={card.name} className="w-full h-full object-cover" />
                        : <div className="w-full h-full bg-muted flex items-center justify-center text-[8px] font-bold text-center px-1 leading-tight">{card.name}</div>
                      }
                    </motion.div>

                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-sm text-foreground truncate">{card.name}</div>
                      <div className="text-[11px] text-muted-foreground leading-snug line-clamp-2 mt-0.5">{card.cardText}</div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground/50 bg-muted rounded-full px-2 py-0.5">{card.function || card.type}</span>
                        {heroBlocked && <span className="text-[10px] text-destructive font-bold">1 hero/turn</span>}
                        {actionBlocked && <span className="text-[10px] text-destructive font-bold">1 action after hero</span>}
                      </div>
                    </div>

                    {isPlayable && (
                      <Button size="sm" className="shrink-0 h-9 px-4 font-bold" onClick={() => handleCardClick(card)}>
                        Play
                      </Button>
                    )}
                  </div>

                  <button
                    className="shrink-0 w-9 h-9 rounded-full bg-background/80 border border-border flex items-center justify-center disabled:opacity-30 active:scale-95 transition-transform"
                    disabled={handFocusIdx >= localPlayerFull.hand.length - 1}
                    onClick={() => setHandFocusIdx(i => i + 1)}
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </div>
              );
            })()}
            {localPlayerFull.hand.length > 1 && (
              <div className="flex justify-center items-center gap-1.5 pb-2.5">
                {localPlayerFull.hand.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setHandFocusIdx(i)}
                    className={cn(
                      "rounded-full transition-all",
                      i === handFocusIdx ? "w-4 h-1.5 bg-primary" : "w-1.5 h-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/60"
                    )}
                  />
                ))}
                <span className="ml-1 text-[10px] text-muted-foreground/40 font-mono">{handFocusIdx + 1}/{localPlayerFull.hand.length}</span>
              </div>
            )}
          </div>
        )}

        {/* ── GRID VIEW ── */}
        {handView === "grid" && (
          <div className="bg-card/95 backdrop-blur-md px-3 pt-2 pb-3">
            {localPlayerFull.hand.length === 0 ? (
              <div className="flex items-center justify-center h-12 text-muted-foreground/50 text-sm italic">No cards in hand</div>
            ) : (
              <div className="flex gap-2 overflow-x-auto pb-1 snap-x snap-mandatory" style={{ scrollbarWidth: "none" }}>
                {localPlayerFull.hand.map((card, idx) => {
                  const isPlayPhase = isMyTurn && gameState.phase === "play" && !gameState.pendingDecision;
                  const heroBlocked = card.type === "hero" && gameState.heroPlayedThisTurn;
                  const actionBlocked = card.type === "action" && gameState.heroPlayedThisTurn && gameState.actionPlayedThisTurn;
                  const isPlayable = isPlayPhase && !heroBlocked && !actionBlocked;
                  const imageSrc = card.imageKey ? assetUrl(card.imageKey) : null;
                  return (
                    <motion.button
                      key={`${card.id}-${idx}`}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: (heroBlocked || actionBlocked) ? 0.45 : 1, y: 0 }}
                      transition={{ delay: idx * 0.04 }}
                      onClick={() => handleCardClick(card)}
                      className={cn(
                        "snap-start shrink-0 flex flex-col items-center gap-1 rounded-xl border-2 p-1.5 transition-all w-[72px]",
                        isPlayable
                          ? "border-primary/60 bg-primary/5 hover:bg-primary/10 hover:border-primary shadow-sm"
                          : "border-border hover:border-border/80 bg-background/30",
                        (heroBlocked || actionBlocked) && "cursor-not-allowed"
                      )}
                    >
                      <div className="w-12 h-16 rounded-lg overflow-hidden shadow-sm border border-border/40 shrink-0">
                        {imageSrc
                          ? <img src={imageSrc} alt={card.name} className="w-full h-full object-cover" />
                          : <div className="w-full h-full bg-muted flex items-center justify-center text-[6px] font-bold text-center px-0.5 leading-tight text-muted-foreground">{card.name}</div>
                        }
                      </div>
                      <span className="text-[8px] font-semibold text-foreground text-center leading-tight line-clamp-2 w-full">{card.name}</span>
                      {isPlayable && (
                        <span className="text-[7px] bg-primary text-primary-foreground rounded-full px-1.5 py-0.5 font-bold leading-none">Play</span>
                      )}
                      {(heroBlocked || actionBlocked) && (
                        <span className="text-[7px] text-destructive font-bold leading-none">Blocked</span>
                      )}
                    </motion.button>
                  );
                })}
              </div>
            )}
          </div>
        )}
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

      {/* DECISION MODAL OVERLAY */}
      {isMyTurn && gameState.pendingDecision && (
        <DecisionModal 
          decision={gameState.pendingDecision}
          gameState={gameState}
          onResolve={handleResolveDecision}
        />
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
