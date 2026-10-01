import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useGameSounds } from "@/hooks/use-game-sounds";
import { useCurrentUser } from "@/components/AppGate";
import { forgetEventSeat, getGameEventCode, rememberedEventSeat, useEventPresence, useGuestEvent, useReadyEvent } from "@/hooks/use-events";
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
  useAskQuestion,
  useLeaveRoom,
  useNudgePlayer,
  getStoredToken,
  storeToken,
} from "@/hooks/use-game";
import { GameCard } from "@/components/GameCard";
import { DecisionModal, PLAYER_SELECTION_TYPES } from "@/components/DecisionModal";
import { EffectAnnouncementOverlay } from "@/components/EffectAnnouncementOverlay";
import { PostGameLinks } from "@/components/PostGameLinks";
import { OnlineRoomEntry } from "@/components/OnlineRoomEntry";
import { getDecisionStepInfo } from "@/lib/decisionSteps";
import { countsForHotPile, getCardBaseId, isHotPileCard } from "@/lib/hotPile";
import { OpponentPileModal } from "@/components/OpponentPileModal";
import {
  PlayerBoardRow,
  PILE_CATEGORIES,
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
  Volume2,
  VolumeX,
  Megaphone,
  Hand,
  Send,
  LogOut,
  Leaf,
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
  const oid = getCardBaseId(card);
  const ACTIVATABLE = ["hot_pile_bonus", "critical_mass", "nitrogen_boost", "rot_regrow"];
  if (!ACTIVATABLE.includes(oid)) return null;
  let canActivate = false;
  let hint = "";
  if (oid === "hot_pile_bonus") {
    const n = me.compostPile.filter(countsForHotPile).length;
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
 * Shared game table for Online, Pass & Play, and Facilitated sessions.
 * Features a desktop-first shared table matrix where every player's pile is visible.
 */
export default function FacilitatedGame() {
  const { gameId } = useParams();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const currentUser = useCurrentUser();

  const urlSeatToken = (() => {
    try {
      return new URLSearchParams(window.location.search).get("token");
    } catch {
      return null;
    }
  })();
  const storedToken = gameId ? getStoredToken(gameId) : null;
  const { data: gameState, isLoading, error } = useGameState(gameId || null, urlSeatToken ?? storedToken);
  const isFacilitated = gameState?.mode === "facilitated";
  const isOnline = gameState?.mode === "online";
  // The legacy facilitator mode is local play, not a facilitated session.
  const isPassPlay = gameState?.mode === "standalone" || gameState?.mode === "facilitator";
  const isRemote = isFacilitated || isOnline;

  useEffect(() => {
    // Only remote tables use seat links; account tokens are never shared in links.
    if (!isRemote || !gameId || !urlSeatToken) return;
    storeToken(gameId, urlSeatToken);
    try {
      const params = new URLSearchParams(window.location.search);
      params.delete("token");
      const query = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : "") + window.location.hash);
    } catch {}
  }, [isRemote, gameId, urlSeatToken]);

  const { claim, loading: claimLoading, requiresPassword, doClaim, error: claimError } = useClaimSlot(
    gameId || null,
    (isFacilitated && !!(storedToken ?? urlSeatToken)) ||
      (isOnline && (gameState?.phase !== "waiting" || !!(storedToken ?? urlSeatToken)))
  );
  const localToken = isRemote ? claim?.token ?? urlSeatToken ?? storedToken : null;
  const eventCode = gameId ? getGameEventCode(gameId) : null;
  const eventSeat = eventCode ? rememberedEventSeat(eventCode) : null;
  useEventPresence(eventCode ?? "", eventSeat, isFacilitated && !!eventSeat && !!localToken);
  const { data: guestEvent } = useGuestEvent(isFacilitated ? eventCode ?? "" : "");
  const eventReady = useReadyEvent(eventCode ?? "");
  const eventClosing = guestEvent?.status === "ending" || guestEvent?.status === "completed";
  const [eventMarkedReady, setEventMarkedReady] = useState(() => {
    try { return !!gameId && localStorage.getItem(`compost_event_ready_${gameId}`) === "yes"; } catch { return false; }
  });
  useEffect(() => {
    try { setEventMarkedReady(isFacilitated && !!gameId && localStorage.getItem(`compost_event_ready_${gameId}`) === "yes"); } catch { setEventMarkedReady(false); }
  }, [gameId, isFacilitated]);
  const hostIsSpectator = (gameState as any)?.hostIsSpectator === true;

  const handleKicked = useCallback(() => {
    if (gameId) {
      try { localStorage.removeItem(`compost_token_${gameId}`); } catch {}
       forgetEventSeat(gameId);
    }
    toast({ title: "You were removed from the room", variant: "destructive" });
    setLocation("/");
  }, [gameId, toast, setLocation]);

  const handleRoomTransfer = useCallback(({ gameId: targetGameId }: { gameId: string; targetToken: string }) => {
    window.location.assign(`/game/${encodeURIComponent(targetGameId)}/table`);
  }, []);

  const { sseConnected } = useGameSse(
    gameId || null,
    localToken,
    isRemote && !!localToken,
    handleKicked,
     (from) => toast({ title: "It's your turn!", description: `${from} is waiting for you to play.`, duration: 6000 }),
    isFacilitated ? handleRoomTransfer : undefined
  );

  const actionMutation = useGameAction(gameId || "", isRemote ? localToken : null, {
    onError: (msg) => toast({ title: "Action failed", description: msg, variant: "destructive" }),
  });
  const leaveRoom = useLeaveRoom(gameId || null, localToken);
  const nudgePlayer = useNudgePlayer(gameId || null, localToken);

  // During a shared-device effect, the human making a choice is the active seat,
  // even when a bot owns the main turn. Remote seats remain token-bound.
  const localDecisionPlayer = isPassPlay && gameState?.pendingDecision
    ? gameState.players.find((p) => p.id === gameState.pendingDecision?.playerId && !p.isBot)
    : null;
  const localPlayerId = isPassPlay
    ? localDecisionPlayer?.id ?? gameState?.players[gameState.currentPlayerIndex]?.id ?? null
    : claim?.playerId ?? null;

  // Sound system
  const { muted: soundMuted, toggleMute: toggleSoundMute } = useGameSounds(gameState ?? undefined, localPlayerId ?? undefined);

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
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const [passScreen, setPassScreen] = useState<{ name: string; cardCount: number } | null>(null);
  const previousLocalTurn = useRef<{
    gameId: string | undefined;
    playerIndex: number;
    turnNumber: number;
    phase: string;
  } | null>(null);

  useLayoutEffect(() => {
    if (!isPassPlay || !gameState) return;
    const idx = gameState.players.findIndex((p) => p.id === localPlayerId);
    const previous = previousLocalTurn.current;
    const needsReveal = !previous || previous.gameId !== gameId ||
      previous.playerIndex !== idx || previous.phase === "game_over" ||
      gameState.turnNumber < previous.turnNumber;
    previousLocalTurn.current = {
      gameId, playerIndex: idx, turnNumber: gameState.turnNumber, phase: gameState.phase,
    };
    if (gameState.phase === "game_over") {
      setPassScreen(null);
      return;
    }
    if (needsReveal) {
      // Clear any prior player's private card preview before the next hand appears.
      setConfirmCard(null);
      const newPlayer = gameState.players[idx];
      setPassScreen(newPlayer && !newPlayer.isBot
        ? { name: newPlayer.name, cardCount: newPlayer.hand.length }
        : null);
    }
  }, [isPassPlay, gameId, localPlayerId, gameState?.phase, gameState?.turnNumber]);

  // Facilitator broadcast + participant questions
  const [dismissedMsgId, setDismissedMsgId] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [askText, setAskText] = useState("");
  const askMutation = useAskQuestion(gameId || null, localToken);
  const myOpenQuestion = !!(gameState?.questions ?? []).some((q) => q.playerId === localPlayerId && !q.resolved);

  const handleAskQuestion = () => {
    askMutation.mutate(askText.trim(), {
      onSuccess: () => {
        setAskOpen(false);
        setAskText("");
         toast({ title: "Question sent", description: "Your facilitator has been notified." });
      },
      onError: (e) => toast({ title: "Couldn't send", description: (e as Error).message, variant: "destructive" }),
    });
  };

  useEffect(() => {
    if (isFacilitated && hostIsSpectator && claim?.playerIndex === -1) {
      setLocation(`/game/${gameId}/host`);
    }
  }, [isFacilitated, hostIsSpectator, claim?.playerIndex, gameId, setLocation]);

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

  if (isLoading || (isFacilitated && claimLoading)) {
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

  if (isOnline && (gameState.phase === "waiting" || !claim)) {
    return <OnlineRoomEntry
      gameId={gameId!}
      gameState={gameState}
      claim={claim}
      token={localToken}
      claimLoading={claimLoading}
      requiresPassword={requiresPassword}
      claimError={claimError}
      doClaim={doClaim}
    />;
  }

  if (isFacilitated && hostIsSpectator && claim?.playerIndex === -1) return null;

  const waitingHostMessage = isFacilitated && gameState.hostMessage && (
    <div className="w-full max-w-md mb-4 rounded-2xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm font-semibold text-foreground" data-testid="waiting-host-message">
      <span className="text-primary font-bold">Facilitator:</span> {gameState.hostMessage.text}
    </div>
  );

  const handleLeaveTable = () => {
    if (!localPlayerId) return;
    leaveRoom.mutate(localPlayerId, {
      onSuccess: () => {
        if (gameId) {
          try { localStorage.removeItem(`compost_token_${gameId}`); } catch {}
           forgetEventSeat(gameId);
        }
        setLocation("/");
      },
      onError: (err) => toast({ title: "Couldn't leave table", description: err.message, variant: "destructive" }),
    });
  };

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
        {waitingHostMessage}
        {localToken ? (
          <div className="bg-card border-2 border-border rounded-3xl p-8 max-w-md w-full text-center shadow-xl">
            <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto mb-4" />
            <h2 className="text-2xl font-display font-bold mb-2">You're at the table!</h2>
             <p className="text-muted-foreground mb-6">Waiting for your facilitator to start the game.</p>
              {isFacilitated && eventCode && eventSeat && <div className="flex flex-col sm:flex-row gap-2 mb-4"><Button className="flex-1" variant="outline" disabled={eventClosing || eventMarkedReady || eventReady.isPending} onClick={() => { if (!eventClosing) eventReady.mutate(eventSeat, { onSuccess: () => { try { localStorage.setItem(`compost_event_ready_${eventSeat.gameId}`, "yes"); } catch {} setEventMarkedReady(true); toast({ title: "Your host knows you're ready" }); }, onError: e => toast({ title: "Couldn't mark ready", description: e.message, variant: "destructive" }) }); }} data-testid="button-table-event-ready">{eventClosing ? "Event closing" : eventMarkedReady ? "You're ready" : "I'm ready"}</Button><Button className="flex-1" variant="outline" onClick={() => setLocation(`/event/${eventCode}`)} data-testid="button-back-event-lobby">Event lobby</Button></div>}
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
            {localPlayerId && claim && claim.playerIndex >= 0 && (
              <Button
                variant="outline"
                className="w-full mt-4 font-bold"
                onClick={handleLeaveTable}
                disabled={leaveRoom.isPending}
                data-testid="button-leave-table"
              >
                {leaveRoom.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <LogOut className="w-4 h-4 mr-2" />}
                Leave table
              </Button>
            )}
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

  const showDecisionModal = isMyDecision && !isInlineTargeting && !passScreen;

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

  const handleMoveLayer = (cardId: string) => {
    if (!isMyTurn || !localPlayerId || actionMutation.isPending) return;
    actionMutation.mutate({ type: "move_card_layer" as any, playerId: localPlayerId, cardId });
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
  const canActivateHotPile = !!(
    gameState.ongoingActionCard &&
    isHotPileCard(gameState.ongoingActionCard) &&
    ongoing?.canActivate &&
    !ongoing.alreadyUsed &&
    isMyTurn &&
    gameState.phase === "play" &&
    !decision
  );

  const stepText = (() => {
    if (gameState.phase === "game_over") return "Game over";
    if (isFacilitated && (gameState as any).paused) return "Game paused by the facilitator";
    if (decision) {
      const owner = gameState.players.find((p) => p.id === decision.playerId);
      return isMyDecision ? `Your choice: ${decision.prompt}` : `${owner?.name ?? "Someone"} is choosing…`;
    }
    if (isMyTurn) return gameState.phase === "draw" ? "Your turn — draw a card" : "Your turn — play a card or end turn";
    return `${currentPlayer.name}'s turn — ${gameState.phase === "draw" ? "drawing" : "playing"}`;
  })();

  const isPlayPhase = isMyTurn && gameState.phase === "play" && !gameState.pendingDecision;

  return (
    <div className="facilitated-table h-[100dvh] bg-background game-table-pattern flex flex-col overflow-hidden text-foreground">
      <AnimatePresence>
        {passScreen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[250] flex items-center justify-center bg-black/90 backdrop-blur-md"
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
                You have <strong className="text-foreground">{passScreen.cardCount}</strong> card{passScreen.cardCount !== 1 ? "s" : ""} waiting for you. Reveal your hand when the device is with you.
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
      {/* HEADER */}
      <header className="shrink-0 min-h-14 flex flex-wrap md:flex-nowrap items-center gap-1.5 md:gap-3 px-2 py-2 md:px-4 md:py-0 bg-card/95 backdrop-blur-md border-b border-border shadow-sm z-30 relative">
        <img src={compostHeroesLogo} alt="Compost Heroes" className="h-8 w-auto shrink-0" draggable={false} />
        <div
          className={cn(
            "order-last md:order-none w-full md:w-auto md:flex-1 min-w-0 flex items-center gap-2 rounded-xl px-3 md:px-4 py-1.5 border shadow-sm text-sm font-bold truncate transition-colors",
            isMyTurn || isMyDecision
              ? "bg-primary/10 border-primary/40 text-primary"
              : "bg-muted/40 border-border text-muted-foreground"
          )}
        >
          {(isMyTurn || isMyDecision) ? <Sparkles className="w-4 h-4 shrink-0" /> : <Loader2 className="w-4 h-4 shrink-0 animate-spin" />}
          <span className="truncate">{stepText}</span>
        </div>
        
        <div className="flex items-center gap-1 md:gap-2 shrink-0 ml-auto">
          {isOnline && !isMyTurn && !currentPlayer.isBot && gameState.phase !== "game_over" && (
            <button
              disabled={nudgePlayer.isPending}
              onClick={() => nudgePlayer.mutate(gameState.currentPlayerIndex, {
                onSuccess: () => toast({ title: "Nudge sent", description: `${currentPlayer.name} has been reminded it's their turn.` }),
                onError: (err) => toast({ title: "Couldn't nudge", description: err.message, variant: "destructive" }),
              })}
              title={`Nudge ${currentPlayer.name}`}
              className="flex items-center gap-1.5 px-2 md:px-3 py-1.5 rounded-xl text-xs font-bold border bg-card border-border text-muted-foreground hover:bg-muted/50 disabled:opacity-50"
              data-testid="button-nudge-player"
            >
              <Hand className="w-4 h-4" /><span className="hidden sm:inline">Nudge</span>
            </button>
          )}
          {isFacilitated && claim?.playerIndex === 0 && currentUser?.role === "facilitator" && currentUser.id === gameState.facilitatorId && (
            <button
              onClick={() => setLocation(`/game/${gameId}/host`)}
              className="flex items-center gap-1.5 px-2 md:px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20"
              title="Open the facilitator dashboard"
            >
              <Crown className="w-4 h-4" /> <span className="hidden sm:inline">Host</span>
            </button>
          )}
          <button
            onClick={() => setShowLog((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 px-2 md:px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors",
              showLog ? "bg-amber-600 text-white border-amber-500" : "bg-card border-border text-muted-foreground hover:bg-muted/50"
            )}
          >
            <History className="w-4 h-4" /> <span className="hidden sm:inline">Recap</span>
          </button>
          <button
            onClick={() => setShowRules((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 px-2 md:px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors",
              showRules ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border text-muted-foreground hover:bg-muted/50"
            )}
          >
            <BookOpen className="w-4 h-4" /> <span className="hidden sm:inline">Rules</span>
          </button>
          {isFacilitated && claim && (
            <div>
              <button
                onClick={() => setAskOpen((v) => !v)}
                disabled={myOpenQuestion}
                title={myOpenQuestion ? "Your question is with the facilitator" : "Ask the facilitator a question"}
                className={cn(
                  "flex items-center gap-1.5 px-2 md:px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors",
                  myOpenQuestion
                    ? "bg-orange-500/15 border-orange-500/40 text-orange-700 dark:text-orange-400 cursor-default"
                    : askOpen
                      ? "bg-orange-500 text-white border-orange-400"
                      : "bg-card border-border text-muted-foreground hover:bg-muted/50"
                )}
                data-testid="button-ask-question"
              >
                <Hand className="w-4 h-4" /> <span className="hidden sm:inline">{myOpenQuestion ? "Asked" : "Ask"}</span>
              </button>
            </div>
          )}
          <button
            onClick={toggleSoundMute}
            title={soundMuted ? "Unmute sounds" : "Mute sounds"}
            className="flex items-center gap-1.5 px-2 md:px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors bg-card border-border text-muted-foreground hover:bg-muted/50"
          >
            {soundMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
          {isRemote && <div
            className={cn(
              "flex items-center gap-1.5 px-2 md:px-3 py-1.5 rounded-xl text-xs font-bold border",
              sseConnected ? "bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-400" : "bg-yellow-500/10 border-yellow-500/30 text-yellow-700 dark:text-yellow-400"
            )}
          >
            <Wifi className={cn("w-3.5 h-3.5", !sseConnected && "animate-pulse")} />
            <span className="hidden md:inline">{sseConnected ? claim?.playerName ?? "Online" : "Reconnecting…"}</span>
          </div>}
        </div>
      </header>

      {/* FACILITATOR BROADCAST BANNER */}
      <AnimatePresence>
        {isFacilitated && gameState.hostMessage && gameState.hostMessage.id !== dismissedMsgId && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="shrink-0 bg-primary/10 border-b border-primary/30 overflow-hidden z-20"
            data-testid="broadcast-banner"
          >
            <div className="flex items-center gap-2.5 px-4 py-2">
              <Megaphone className="w-4 h-4 text-primary shrink-0" />
              <span className="flex-1 min-w-0 text-sm font-semibold text-foreground truncate">
                <span className="text-primary font-bold">Facilitator:</span> {gameState.hostMessage.text}
              </span>
              <button
                onClick={() => setDismissedMsgId(gameState.hostMessage!.id)}
                className="text-muted-foreground hover:text-foreground shrink-0"
                title="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* MAIN CONTENT SPLIT */}
      <div className="flex-1 flex flex-row overflow-hidden relative">
        {mobileControlsOpen && (
          <button
            type="button"
            className="absolute inset-0 z-20 bg-black/30 md:hidden"
            onClick={() => setMobileControlsOpen(false)}
            aria-label="Close controls and return to the table"
            data-testid="button-close-controls-backdrop"
          />
        )}
        <button
          type="button"
          className="absolute top-3 z-40 md:hidden flex h-11 items-center gap-1 rounded-l-xl border border-r-0 border-primary/40 bg-card px-2.5 text-xs font-bold text-primary shadow-lg"
          style={{ right: mobileControlsOpen ? "min(320px, calc(100vw - 48px))" : 0 }}
          onClick={() => setMobileControlsOpen((open) => !open)}
          aria-controls="table-controls"
          aria-expanded={mobileControlsOpen}
          aria-label={
            mobileControlsOpen
              ? "Hide draw, discard and turn controls"
              : canActivateHotPile
                ? "Open turn controls to activate Hot Pile Bonus"
                : "Show draw, discard and turn controls"
          }
          data-testid="button-toggle-mobile-controls"
        >
          {mobileControlsOpen ? <ChevronRight className="h-5 w-5" /> : <ChevronLeft className="h-5 w-5" />}
          {!mobileControlsOpen && (
            <span>
              {canActivateHotPile
                ? "Activate effect"
                : isMyTurn && !decision
                  ? gameState.phase === "draw" ? "Draw card" : "Turn controls"
                  : "Controls"}
            </span>
          )}
        </button>
        {/* LEFT: Matrix Board + Footer Hand */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden relative bg-black/5 shadow-inner">
          
          {/* THE MATRIX BOARD */}
          <div className="flex-1 min-h-0 overflow-auto px-3 py-2 xl:px-6 xl:py-3 custom-scrollbar">
            <div className="flex flex-col gap-2 w-max mx-auto pb-4">
              
              {/* TARGETING BANNER */}
              {isInlineTargeting && (
                <div className="flex items-center justify-center gap-2 text-sm font-bold text-destructive bg-destructive/10 border border-destructive/30 rounded-xl px-4 py-3 mb-2 animate-pulse shadow-sm w-full">
                  <Crosshair className="w-5 h-5 shrink-0" />
                  <span>Choose a highlighted player for the effect</span>
                </div>
              )}

              {/* MATRIX HEADERS */}
              <div className="flex gap-[var(--board-gap)] px-3">
                <div className="w-[var(--board-info)] shrink-0" /> {/* Info spacer */}
                {PILE_CATEGORIES.map(cat => (
                  <div key={cat.key} className={cn("w-[var(--board-card-w)] shrink-0 flex items-center justify-center gap-1", cat.color)}>
                    <img src={cat.iconSrc} alt={cat.label} className="w-4 h-4 xl:w-5 xl:h-5 drop-shadow-sm mix-blend-multiply dark:mix-blend-normal" draggable={false} />
                    <span className="font-display font-bold tracking-wide text-[10px] xl:text-[13px] drop-shadow-sm">{cat.label}</span>
                  </div>
                ))}
              </div>

              {/* ROWS */}
              {orderedPlayers.map(p => (
                <PlayerBoardRow
                  key={p.id}
                  player={p}
                  isMe={p.id === localPlayerId}
                  showHandBacks={p.id !== localPlayerId}
                  isTurn={p.id === currentPlayer.id}
                  modifiers={gameState.activeModifiers.filter((m) => m.appliedByPlayerId === p.id)}
                  targetingActive={isInlineTargeting}
                  isEligibleTarget={eligibleTargetIds.has(p.id)}
                  onTarget={() => handleTargetOpponent(p)}
                  onViewPile={() => setViewingOpponent(p)}
                  onZoomCard={setZoomedCard}
                  onMoveLayer={p.id === localPlayerId && isMyTurn && !isInlineTargeting ? handleMoveLayer : undefined}
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
                  showHandBacks={false}
                  isTurn={myRowPlayer.id === currentPlayer.id}
                  modifiers={gameState.activeModifiers.filter((m) => m.appliedByPlayerId === myRowPlayer.id)}
                  targetingActive={isInlineTargeting}
                  isEligibleTarget={eligibleTargetIds.has(myRowPlayer.id)}
                  onTarget={() => handleTargetOpponent(myRowPlayer)}
                  onViewPile={() => setViewingOpponent(myRowPlayer)}
                  onZoomCard={setZoomedCard}
                  onMoveLayer={isMyTurn && !isInlineTargeting ? handleMoveLayer : undefined}
                />
              </div>
            </div>
          )}

          {/* MY HAND FOOTER — tall enough to show full md cards (208px) + header */}
          <div className={cn("table-hand-footer shrink-0 h-[188px] md:h-[208px] xl:h-[252px] bg-card/95 backdrop-blur-2xl border-t border-border/60 shadow-[0_-10px_40px_rgba(0,0,0,0.1)] z-20 flex flex-col relative before:absolute before:inset-0 before:bg-gradient-to-t before:from-background/20 before:pointer-events-none", passScreen && "invisible")} aria-hidden={!!passScreen}>
             <div className="px-3 md:px-6 py-2 md:py-2.5 border-b border-border/40 bg-muted/20 flex justify-between items-center relative z-10">
               <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                 Your Hand <span className="bg-background px-2.5 py-0.5 rounded-full border shadow-sm">{me.hand.length} / {me.maxHandSize}</span>
               </span>
               {me.skipsNextTurn && <span className="text-xs font-bold text-destructive flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5"/> Skips Next Turn</span>}
             </div>
              <div className="flex-1 flex items-center px-3 md:px-8 overflow-x-auto gap-2 md:gap-4 custom-scrollbar relative z-10 py-1 md:py-2">
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
                       className="shrink-0 h-full py-1 md:py-2 flex items-center"
                    >
                      <GameCard 
                        card={card} 
                         size="sm"
                        showText={false}
                        onClick={() => playable ? handleCardClick(card) : setZoomedCard(card)}
                        className={cn(
                           "md:w-[var(--hand-card-w)] md:h-[var(--hand-card-h)] md:rounded-xl cursor-zoom-in transition-all duration-300",
                          playable ? "cursor-pointer hover:-translate-y-4 hover:scale-105 hover:shadow-2xl hover:border-primary ring-offset-background" : "",
                          isBlocked && "grayscale-[20%]"
                        )}
                      />
                    </motion.div>
                  );
                })}
             </div>
          </div>
        </div>

        {/* RIGHT SIDEBAR */}
        <div
          id="table-controls"
          className={cn(
            "absolute inset-y-0 right-0 w-[calc(100vw-48px)] max-w-[320px] shrink-0 bg-card/95 backdrop-blur-2xl border-l border-border/60 flex flex-col shadow-[-10px_0_40px_rgba(0,0,0,0.1)] z-30 transition-transform duration-300 motion-reduce:transition-none md:static md:w-[280px] xl:w-[320px] md:max-w-none md:translate-x-0 md:pointer-events-auto",
            mobileControlsOpen ? "translate-x-0 pointer-events-auto" : "translate-x-full pointer-events-none"
          )}
        >
          
          {/* Decks */}
          <div className="p-3 xl:p-6 border-b border-border/40 bg-muted/10 flex justify-center gap-4 xl:gap-6">
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
                    "w-20 h-[120px] xl:w-24 xl:h-36 rounded-xl border-[3px] shadow-lg bg-cover bg-center transition-all",
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
                  <GameCard card={topDiscard} size="sm" hoverable={false} className="w-20 h-[120px] xl:w-24 xl:h-36 shadow-lg border-border" />
                ) : (
                  <div className="w-20 h-[120px] xl:w-24 xl:h-36 rounded-xl border-[3px] border-dashed border-border/50 flex items-center justify-center bg-black/5 shadow-inner">
                    <RefreshCcw className="w-6 h-6 text-muted-foreground/30" />
                  </div>
                )}
              </button>
            </div>
          </div>

          {/* Ongoing Effects */}
          <div className="flex-1 min-h-0 overflow-y-auto p-3 xl:p-6 flex flex-col gap-4 xl:gap-6 custom-scrollbar">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-bold tracking-widest uppercase text-orange-600 dark:text-orange-400 border-b border-border/50 pb-2 mb-3">
                 <CircleDot className="w-3.5 h-3.5" /> Ongoing Card
              </div>
              {gameState.ongoingActionCard ? (
                <div className="flex flex-col gap-3 bg-orange-500/5 border border-orange-500/20 rounded-xl p-3 shadow-sm">
                   <GameCard card={gameState.ongoingActionCard} size="sm" className="mx-auto shadow-md" hoverable={false} onClick={() => setZoomedCard(gameState.ongoingActionCard!)} />
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
                        {ongoing.alreadyUsed
                          ? "Used this turn"
                          : ongoing.canActivate
                            ? <><Zap className="w-3 h-3 mr-1.5"/> {isHotPileCard(gameState.ongoingActionCard) ? "Activate Hot Pile Bonus" : "Activate Effect"}</>
                            : ongoing.hint}
                     </Button>
                   )}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground/50 italic text-xs border-2 border-dashed border-border/50 rounded-xl bg-black/5">
                  None active
                </div>
              )}
            </div>

            {gameState.activeModifiers.filter(m => !gameState.ongoingActionCard || m.cardId !== getCardBaseId(gameState.ongoingActionCard)).length > 0 && (
              <div>
                <div className="flex items-center gap-2 text-[11px] font-bold tracking-widest uppercase text-primary border-b border-border/50 pb-2 mb-3">
                   <Sparkles className="w-3.5 h-3.5" /> Active Modifiers
                </div>
                <div className="flex flex-col gap-2">
                  {gameState.activeModifiers
                    .filter((m) => !gameState.ongoingActionCard || m.cardId !== getCardBaseId(gameState.ongoingActionCard))
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
          <div className="shrink-0 h-[150px] xl:h-[190px] p-3 xl:p-6 border-t border-border/40 bg-muted/10 flex flex-col justify-center gap-4 relative before:absolute before:inset-0 before:bg-gradient-to-t before:from-background/30 before:to-transparent before:pointer-events-none">
            <div className="relative z-10 flex flex-col gap-4 h-full justify-center">
              {canActivateHotPile && (
                <Button
                  size="sm"
                  onClick={handleActivateOngoing}
                  disabled={actionMutation.isPending}
                  className="hidden md:flex h-10 w-full animate-pulse items-center justify-center gap-2 border border-orange-400 bg-orange-500 font-bold text-white shadow-lg hover:bg-orange-600"
                >
                  <Zap className="h-4 w-4" />
                  Activate Hot Pile Bonus
                </Button>
              )}
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

      {/* Body portal avoids the header's stacking context and the clipped table/controls. */}
      {createPortal(
        <AnimatePresence>
          {isFacilitated && askOpen && !myOpenQuestion && (
            <motion.div
              key="ask-question"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[200] flex items-center justify-center bg-foreground/55 p-4 backdrop-blur-sm"
              onMouseDown={(e) => { if (e.target === e.currentTarget) setAskOpen(false); }}
            >
              <motion.div
                role="dialog"
                aria-modal="true"
                aria-labelledby="ask-question-title"
                initial={{ opacity: 0, y: 12, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 12, scale: 0.97 }}
                className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-2xl"
                onKeyDown={(e) => { if (e.key === "Escape") setAskOpen(false); }}
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h2 id="ask-question-title" className="font-display text-xl">Ask your facilitator</h2>
                    <p className="text-sm text-muted-foreground">Your question goes directly to the host.</p>
                  </div>
                  <button type="button" aria-label="Close question" onClick={() => setAskOpen(false)} className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground" data-testid="button-close-question">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <input
                  value={askText}
                  onChange={(e) => setAskText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAskQuestion(); }}
                  maxLength={300}
                  autoFocus
                  placeholder="Type your question (optional)…"
                  className="mb-3 h-11 w-full rounded-xl border border-border bg-background/50 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                  data-testid="input-question"
                />
                <Button
                  size="sm"
                  className="w-full rounded-xl font-bold"
                  disabled={askMutation.isPending}
                  onClick={handleAskQuestion}
                  data-testid="button-send-question"
                >
                  {askMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                    <><Send className="w-4 h-4 mr-1.5" /> {askText.trim() ? "Send question" : "Raise hand"}</>
                  )}
                </Button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* Rules popover */}
      <AnimatePresence>
        {showRules && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="fixed top-24 left-3 right-3 md:top-16 md:left-auto md:right-[340px] z-[65] md:w-80 bg-card border border-border rounded-2xl shadow-2xl overflow-y-auto max-h-[70dvh]"
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
            className="fixed top-24 left-3 right-3 md:top-16 md:left-auto md:right-[340px] z-[65] md:w-80 bg-card border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden max-h-[60vh]"
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

      {/* Play confirmation modal — card on left, explanation on right */}
      <AnimatePresence>
        {confirmCard && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 md:p-6"
            onClick={() => setConfirmCard(null)}
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-card rounded-3xl shadow-2xl border flex flex-col md:flex-row gap-0 overflow-y-auto max-h-[calc(100dvh-24px)] max-w-2xl w-full"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Full card — no text overlay */}
              <div className="shrink-0 p-3 md:p-6 flex items-center justify-center bg-muted/30">
                <GameCard card={confirmCard} size="sm" hoverable={false} showText={false} className="md:w-64 md:h-96 md:rounded-2xl shadow-2xl" />
              </div>

              {/* Explanation panel */}
              <div className="flex-1 flex flex-col justify-between p-4 md:p-6 min-w-0">
                <div>
                  <h2 className="text-2xl font-display font-bold mb-1" style={{ color: confirmCard.function ? undefined : undefined }}>
                    {confirmCard.name}
                  </h2>
                  <div className="flex items-center gap-2 mb-4">
                    <span className="text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                      {confirmCard.effectType === "instant" ? "⚡ Instant" : confirmCard.effectType === "ongoing" ? "⏳ Ongoing" : confirmCard.type}
                    </span>
                    {confirmCard.function && (
                      <span className="text-xs text-muted-foreground font-medium">{confirmCard.function}</span>
                    )}
                  </div>

                  <p className="text-base font-semibold text-foreground leading-snug mb-4">
                    {confirmCard.cardText}
                  </p>

                  {confirmCard.effectType === "instant" && (
                    <p className="text-sm text-muted-foreground">This card takes effect immediately and goes to the discard pile.</p>
                  )}
                  {confirmCard.effectType === "ongoing" && (
                    <p className="text-sm text-muted-foreground">This card stays in play and its effect lasts until activated or removed.</p>
                  )}
                  {confirmCard.type === "hero" && (
                    <p className="text-sm text-muted-foreground">Playing this hero card adds it to your compost pile. You can only play one hero per turn.</p>
                  )}
                </div>

                <div className="flex gap-3 mt-6">
                  <Button variant="outline" className="flex-1 h-12" onClick={() => setConfirmCard(null)}>
                    Cancel
                  </Button>
                  <Button className="flex-1 h-12 font-bold text-base" onClick={() => handlePlayCard(confirmCard.id)} disabled={actionMutation.isPending}>
                    {actionMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Play Card"}
                  </Button>
                </div>
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
              className="fixed inset-0 z-[90] bg-black/75 backdrop-blur-md flex flex-col items-center justify-center p-3 md:p-6 overflow-auto"
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
                    className="grid grid-cols-3 gap-2 md:gap-3"
                  >
                    {pageCards.map((card, i) => (
                      <div
                        key={`${card.id}-${i}`}
                        className="cursor-zoom-in"
                        onClick={() => setZoomedCard(card)}
                      >
                        <GameCard card={card} size="md" hoverable={false} className="w-auto h-[min(20dvh,13rem)] aspect-[9/13] shadow-lg hover:scale-105 transition-transform duration-150" />
                      </div>
                    ))}
                    {/* Fill empty slots so grid stays stable */}
                    {Array.from({ length: PAGE - pageCards.length }).map((_, i) => (
                      <div key={`empty-${i}`} className="w-auto h-[min(20dvh,13rem)] aspect-[9/13]" />
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
            className="fixed inset-0 z-[95] bg-black/75 backdrop-blur-md flex items-center justify-center p-6 cursor-zoom-out"
            onClick={() => setZoomedCard(null)}
          >
            <motion.div
              initial={{ scale: 0.8, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.8, y: 20 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
            >
              <GameCard card={zoomedCard} size="lg" hoverable={false} showText={false} className="w-[min(64vw,16rem)] h-auto aspect-[2/3] max-h-[85dvh] shadow-2xl" />
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
      <EffectAnnouncementOverlay effect={gameState.lastEffect ?? null} localPlayerId={localPlayerId} />

      {/* Game Over Screen */}
      {gameState.phase === "game_over" && (
        <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.8, y: 50, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            transition={{ type: "spring", bounce: 0.5 }}
            className="bg-card rounded-3xl p-6 md:p-8 max-w-lg w-full max-h-[calc(100dvh-2rem)] overflow-y-auto text-center border-4 border-primary shadow-2xl relative"
          >
            <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-primary via-yellow-400 to-primary" />
            <h2 className="text-5xl font-display font-bold text-foreground mb-2">Game Over!</h2>
            <div className="text-2xl font-medium text-muted-foreground mb-8">
              {gameState.winner ? <>Winner: <span className="font-bold text-primary">{gameState.players.find((p) => p.id === gameState.winner)?.name}</span></> : "This round was ended by the host."}
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
              {!gameState.eventId && <Button
                size="lg"
                className="w-full text-lg font-bold h-14"
                disabled={actionMutation.isPending}
                onClick={() => {
                  if (localPlayerId) actionMutation.mutate({ type: "reset_game" as any, playerId: localPlayerId });
                }}
              >
                Play Again
              </Button>}
              <Button size="lg" variant="outline" className="w-full text-lg font-bold h-14" onClick={() => setLocation(gameState.eventId && eventCode ? `/event/${eventCode}/results` : "/")} data-testid="button-postgame-return">
                {gameState.eventId && eventCode ? "Return to Event" : "Return to Lobby"}
              </Button>
            </div>
            <PostGameLinks className="mt-6 text-left" />
          </motion.div>
        </div>
      )}
    </div>
  );
}