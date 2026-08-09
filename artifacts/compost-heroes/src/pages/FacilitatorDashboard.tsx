import { useEffect } from "react";
import { useParams, useLocation, Link } from "wouter";
import { motion } from "framer-motion";
import compostHeroesLogo from "@assets/Compost_Heroes_Logo_no_background_1773537933517.png";
import {
  useGameState,
  useGameSse,
  useClaimSlot,
  useNudgePlayer,
  usePauseGame,
  useFacilitatorResolve,
  getStoredToken,
  storeToken,
} from "@/hooks/use-game";
import {
  PILE_CATEGORIES,
  getEffectiveFn,
  collectedCategoryCount,
} from "@/components/facilitated/OpponentSummary";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Loader2,
  AlertCircle,
  Bell,
  Pause,
  Play,
  LifeBuoy,
  Wifi,
  History,
  Sparkles,
  Hourglass,
  ArrowLeft,
  Crown,
} from "lucide-react";

/**
 * Facilitator dashboard for corporate sessions: all players' piles and win
 * progress at a glance, current turn/step, pending decision status, activity
 * feed, and assist controls (nudge / pause / step-in resolve).
 * Gated by the host token (player index 0).
 */
export default function FacilitatorDashboard() {
  const { gameId } = useParams();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  // Allow ?token= seeding like the table route (host share/bookmark links)
  const urlToken = (() => {
    try {
      return new URLSearchParams(window.location.search).get("token");
    } catch {
      return null;
    }
  })();
  if (gameId && urlToken) {
    storeToken(gameId, urlToken);
    try {
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    } catch {}
  }

  const storedToken = gameId ? getStoredToken(gameId) : null;
  const { data: gameState, isLoading, error } = useGameState(gameId || null, storedToken);
  const isFacilitated = gameState?.mode === "facilitated";

  // Re-validate the stored token → playerIndex (host gate)
  const { claim, loading: claimLoading } = useClaimSlot(gameId || null, isFacilitated && !!storedToken);
  const token = claim?.token ?? storedToken;
  const isHost = claim ? claim.playerIndex === 0 : null;

  const { sseConnected } = useGameSse(gameId || null, token, isFacilitated && !!token);

  const nudgeMutation = useNudgePlayer(gameId || null, token);
  const pauseMutation = usePauseGame(gameId || null, token);
  const resolveMutation = useFacilitatorResolve(gameId || null, token);

  // Gate: not facilitated, no token, or not the host → back to the game
  useEffect(() => {
    if (!gameState) return;
    if (gameState.mode !== "facilitated" || !storedToken) {
      setLocation(`/game/${gameId}`);
    }
  }, [gameState?.mode, storedToken, gameId, setLocation, gameState]);

  useEffect(() => {
    if (isHost === false) {
      toast({ title: "Facilitator only", description: "Only the session host can open this dashboard.", variant: "destructive" });
      setLocation(`/game/${gameId}/table`);
    }
  }, [isHost, gameId, setLocation, toast]);

  if (isLoading || claimLoading || (gameState && isHost === null && isFacilitated)) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center">
        <Loader2 className="w-10 h-10 text-primary animate-spin mb-3" />
        <h2 className="text-xl font-display text-foreground">Opening facilitator dashboard…</h2>
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

  if (gameState.mode !== "facilitated" || isHost === false) return null; // guards redirect

  const paused = (gameState as any).paused === true;
  const decision = gameState.pendingDecision;
  const currentPlayer = gameState.players[gameState.currentPlayerIndex];
  const decisionOwner = decision ? gameState.players.find((p) => p.id === decision.playerId) : null;
  const isWaitingRoom = gameState.phase === "waiting";

  const statusText = (() => {
    if (isWaitingRoom) return "Waiting room — game not started yet";
    if (gameState.phase === "game_over")
      return `Game over — ${gameState.players.find((p) => p.id === gameState.winner)?.name ?? "someone"} wins!`;
    if (paused) return "Game paused";
    if (decision) return `Waiting on ${decisionOwner?.name ?? "a player"}: ${decision.prompt}`;
    return `${currentPlayer?.name}'s turn — ${gameState.phase === "draw" ? "drawing a card" : "playing a card"}`;
  })();

  const handleNudge = (playerIndex: number, name: string) => {
    nudgeMutation.mutate(playerIndex, {
      onSuccess: () => toast({ title: `Nudged ${name}`, description: "They'll see a friendly reminder." }),
      onError: (e) => toast({ title: "Nudge failed", description: (e as Error).message, variant: "destructive" }),
    });
  };

  return (
    <div className="min-h-screen bg-background game-table-pattern flex flex-col text-foreground">
      {/* Header */}
      <header className="shrink-0 flex items-center gap-2 px-3 py-2 bg-card/90 backdrop-blur-md border-b border-border z-20">
        <img src={compostHeroesLogo} alt="Compost Heroes" className="h-7 w-auto shrink-0" draggable={false} />
        <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30 rounded-full px-2.5 py-1 shrink-0">
          <Crown className="w-3.5 h-3.5" /> Facilitator
        </span>
        <div
          className={cn(
            "flex-1 min-w-0 flex items-center gap-2 rounded-full px-3 py-1 border text-sm font-bold truncate",
            paused
              ? "bg-yellow-500/15 border-yellow-500/40 text-yellow-700 dark:text-yellow-400"
              : decision
                ? "bg-destructive/10 border-destructive/30 text-destructive"
                : "bg-primary/10 border-primary/30 text-primary"
          )}
          data-testid="facilitator-status-banner"
        >
          {paused ? <Pause className="w-3.5 h-3.5 shrink-0" /> : decision ? <Hourglass className="w-3.5 h-3.5 shrink-0" /> : <Sparkles className="w-3.5 h-3.5 shrink-0" />}
          <span className="truncate">{statusText}</span>
        </div>
        <Link
          href={`/game/${gameId}/table`}
          className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold border bg-background/80 border-border text-muted-foreground hover:text-foreground shrink-0"
          data-testid="back-to-table"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> <span className="hidden sm:inline">My table</span>
        </Link>
        <div
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold border shrink-0",
            sseConnected ? "bg-green-500/15 border-green-500/30 text-green-600" : "bg-yellow-500/15 border-yellow-500/30 text-yellow-600"
          )}
        >
          <Wifi className={cn("w-3 h-3", !sseConnected && "animate-pulse")} />
          <span className="hidden md:inline">{sseConnected ? "Live" : "Reconnecting…"}</span>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-3 p-3">
        {/* Left: players + table state */}
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          {/* Assist controls */}
          <div className="flex flex-wrap items-center gap-2 bg-card/90 backdrop-blur-md border border-border rounded-2xl px-3 py-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mr-1">Assist</span>
            <Button
              size="sm"
              variant={paused ? "default" : "outline"}
              className="font-bold rounded-xl"
              disabled={pauseMutation.isPending || isWaitingRoom || gameState.phase === "game_over"}
              onClick={() =>
                pauseMutation.mutate(!paused, {
                  onError: (e) => toast({ title: "Failed", description: (e as Error).message, variant: "destructive" }),
                })
              }
              data-testid="button-pause"
            >
              {pauseMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : paused ? <Play className="w-4 h-4 mr-1.5" /> : <Pause className="w-4 h-4 mr-1.5" />}
              {paused ? "Resume game" : "Pause game"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="font-bold rounded-xl border-destructive/40 text-destructive hover:bg-destructive/10"
              disabled={!decision || resolveMutation.isPending}
              title={decision ? `Auto-resolve ${decisionOwner?.name ?? "the player"}'s stuck choice` : "No pending decision"}
              onClick={() =>
                resolveMutation.mutate(undefined, {
                  onSuccess: () => toast({ title: "Decision resolved", description: "You stepped in and the game moved on." }),
                  onError: (e) => toast({ title: "Failed", description: (e as Error).message, variant: "destructive" }),
                })
              }
              data-testid="button-facilitator-resolve"
            >
              {resolveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <LifeBuoy className="w-4 h-4 mr-1.5" />}
              Resolve stuck decision
            </Button>
            {decision && (
              <span className="text-xs text-muted-foreground truncate">
                Waiting on <strong className="text-foreground">{decisionOwner?.name}</strong>
              </span>
            )}
          </div>

          {/* Player grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {gameState.players.map((player, idx) => {
              const isTurn = !isWaitingRoom && idx === gameState.currentPlayerIndex;
              const waitingOnThem = !!decision && decision.playerId === player.id;
              const collected = collectedCategoryCount(player.compostPile);
              const modifiers = gameState.activeModifiers.filter((m) => m.appliedByPlayerId === player.id);
              return (
                <motion.div
                  key={player.id}
                  layout
                  className={cn(
                    "bg-card/90 backdrop-blur-md rounded-2xl border-2 p-3 flex flex-col gap-2",
                    waitingOnThem ? "border-destructive/60 shadow-md shadow-destructive/10" : isTurn ? "border-primary shadow-md shadow-primary/10" : "border-border"
                  )}
                  data-testid={`facilitator-player-${player.id}`}
                >
                  <div className="flex items-center gap-2">
                    <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center text-secondary-foreground font-display text-lg shrink-0">
                      {player.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-display font-bold text-sm leading-tight truncate flex items-center gap-1.5">
                        {player.name}
                        {idx === 0 && <Crown className="w-3 h-3 text-amber-500 shrink-0" />}
                        {(player as any).isBot && <span className="text-[9px] font-bold uppercase bg-muted rounded-full px-1.5">Bot</span>}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {player.hand.length} in hand · {player.compostPile.length} in pile
                        {player.skipsNextTurn && <span className="text-destructive font-bold"> · skips next turn</span>}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {isTurn && (
                        <span className="text-[9px] font-bold uppercase tracking-wider bg-primary text-primary-foreground rounded-full px-2 py-px">Turn</span>
                      )}
                      {waitingOnThem && (
                        <span className="text-[9px] font-bold uppercase tracking-wider bg-destructive text-destructive-foreground rounded-full px-2 py-px animate-pulse">Deciding</span>
                      )}
                    </div>
                  </div>

                  {/* Win progress */}
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto">
                      {PILE_CATEGORIES.map((cat) => {
                        const count = player.compostPile.filter((c) => c != null && cat.match(getEffectiveFn(c))).length;
                        const has = count > 0;
                        return (
                          <div key={cat.key} className="flex flex-col items-center gap-px shrink-0" title={`${cat.label}: ${has ? `${count}` : "missing"}`}>
                            <img src={cat.iconSrc} alt={cat.label} className={cn("w-4 h-4 object-contain", !has && "opacity-25 grayscale")} draggable={false} />
                            <div className={cn("w-2.5 h-2.5 rounded-full border border-black/10", has ? cat.dotFilled : cat.dotEmpty)} />
                          </div>
                        );
                      })}
                    </div>
                    <span
                      className={cn(
                        "shrink-0 text-[10px] font-bold rounded-full px-2 py-0.5 border",
                        collected === 4
                          ? "bg-red-100 text-red-700 border-red-300 dark:bg-red-950/50 dark:text-red-400"
                          : collected >= 3
                            ? "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/50 dark:text-amber-400"
                            : "bg-muted text-muted-foreground border-border"
                      )}
                    >
                      {collected === 4 ? "1 away!" : `${collected}/5`}
                    </span>
                  </div>

                  {modifiers.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {modifiers.map((m, i) => (
                        <span key={i} title={m.effect} className="text-[9px] font-bold text-primary bg-primary/10 border border-primary/25 rounded-full px-1.5 py-px max-w-[10rem] truncate">
                          ✨ {m.cardName}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Nudge */}
                  {idx !== 0 && !(player as any).isBot && !isWaitingRoom && gameState.phase !== "game_over" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="font-bold rounded-xl self-start h-7 text-xs"
                      disabled={nudgeMutation.isPending}
                      onClick={() => handleNudge(idx, player.name)}
                      data-testid={`button-nudge-${player.id}`}
                    >
                      <Bell className="w-3.5 h-3.5 mr-1" /> Nudge
                    </Button>
                  )}
                </motion.div>
              );
            })}
          </div>

          {/* Shared table state */}
          <div className="flex flex-wrap items-center gap-2 bg-card/90 backdrop-blur-md border border-border rounded-2xl px-3 py-2 text-xs">
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mr-1">Table</span>
            <span className="font-bold bg-background/80 border rounded-full px-2.5 py-1">Turn {gameState.turnNumber}</span>
            <span className="font-bold bg-background/80 border rounded-full px-2.5 py-1">Draw pile: {gameState.deckCount ?? 0}</span>
            <span className="font-bold bg-background/80 border rounded-full px-2.5 py-1">Discard: {gameState.discardPile.length}</span>
            {gameState.ongoingActionCard && (
              <span className="font-bold bg-orange-500/10 border border-orange-400/40 text-orange-700 dark:text-orange-400 rounded-full px-2.5 py-1 truncate max-w-[16rem]">
                Ongoing: {gameState.ongoingActionCard.name}
              </span>
            )}
          </div>
        </div>

        {/* Right: activity feed */}
        <div className="lg:w-80 shrink-0 bg-card/90 backdrop-blur-md border border-border rounded-2xl overflow-hidden flex flex-col max-h-[50vh] lg:max-h-none">
          <div className="px-4 py-2 bg-muted/50 border-b border-border flex items-center gap-1.5 shrink-0">
            <History className="w-3.5 h-3.5 text-amber-600" />
            <span className="font-bold text-xs uppercase tracking-wider">Recent activity</span>
          </div>
          <div className="overflow-y-auto p-2.5 flex flex-col gap-1 text-[11px] flex-1" data-testid="facilitator-activity-feed">
            {gameState.log.length === 0 && <div className="text-center text-muted-foreground/50 italic py-4">No moves yet.</div>}
            {[...gameState.log].reverse().map((entry, i) => (
              <div
                key={i}
                className={cn(
                  "py-1 px-1.5 rounded border-b border-border/20 last:border-0 leading-snug",
                  i === 0 ? "bg-amber-50/60 dark:bg-amber-950/20 font-medium" : "text-muted-foreground"
                )}
              >
                {entry}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
