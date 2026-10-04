import { useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { motion } from "framer-motion";
import compostHeroesLogo from "@assets/Compost_Heroes_Logo_no_background_1773537933517.png";
import {
  useGameState,
  useGameSse,
  useClaimSlot,
  useNudgePlayer,
  useKickPlayer,
  usePauseGame,
  useFacilitatorResolve,
  useSendHostMessage,
  useResolveQuestion,
  useEndSession,
  useStartGame,
  useReorderWaitingPlayers,
  useTransferWaitingPlayer,
  useFacilitatorRooms,
  getStoredToken,
  storeToken,
} from "@/hooks/use-game";
import {
  PILE_CATEGORIES,
  getEffectiveFn,
  collectedCategoryCount,
} from "@/components/facilitated/OpponentSummary";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/components/AppGate";
import { getGameEventId } from "@/hooks/use-events";
import { cn } from "@/lib/utils";
import {
  Loader2,
  AlertCircle,
  Bell,
  UserX,
  Pause,
  Play,
  LifeBuoy,
  Wifi,
  History,
  Sparkles,
  Hourglass,
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  MoveRight,
  Crown,
  Megaphone,
  Send,
  HelpCircle,
  Check,
  Copy,
  Flag,
  Trophy,
  Clock,
} from "lucide-react";
import { useState } from "react";

/**
 * Facilitator dashboard for corporate sessions: all players' piles and win
 * progress at a glance, current turn/step, pending decision status, activity
 * feed, and assist controls (nudge / pause / step-in resolve).
 * Gated by the host token (seat -1 in spectator-host rooms, seat 0 in legacy rooms).
 */
export default function FacilitatorDashboard() {
  const { gameId } = useParams();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const currentUser = useCurrentUser();

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
      const params = new URLSearchParams(window.location.search);
      params.delete("token");
      const query = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : "") + window.location.hash);
    } catch {}
  }

  const storedToken = gameId ? getStoredToken(gameId) : null;
  const { data: gameState, isLoading, error } = useGameState(gameId || null, storedToken);
  const isFacilitated = gameState?.mode === "facilitated";

  // Re-validate the stored token → playerIndex (host gate)
  const { claim, loading: claimLoading } = useClaimSlot(gameId || null, isFacilitated && !!storedToken);
  const token = claim?.token ?? storedToken;
  const hostIsSpectator = (gameState as any)?.hostIsSpectator === true;
  const isHost = claim ? claim.playerIndex === (hostIsSpectator ? -1 : 0) : null;

  const { sseConnected } = useGameSse(gameId || null, token, isFacilitated && !!token);

  const nudgeMutation = useNudgePlayer(gameId || null, token);
  const kickMutation = useKickPlayer(gameId || null, token);
  const pauseMutation = usePauseGame(gameId || null, token);
  const resolveMutation = useFacilitatorResolve(gameId || null, token);
  const messageMutation = useSendHostMessage(gameId || null, token);
  const resolveQuestionMutation = useResolveQuestion(gameId || null, token);
  const endMutation = useEndSession(gameId || null, token);
  const startMutation = useStartGame(gameId || null, token);
  const reorderMutation = useReorderWaitingPlayers(gameId || null, token);
  const transferMutation = useTransferWaitingPlayer(gameId || null, token);
  const { data: facilitatorRooms = [] } = useFacilitatorRooms(isHost === true && isFacilitated);

  const [broadcastText, setBroadcastText] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [kickTarget, setKickTarget] = useState<{ id: string; name: string } | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);

  const handleSendBroadcast = () => {
    const text = broadcastText.trim();
    if (!text) return;
    messageMutation.mutate(text, {
      onSuccess: () => {
        setBroadcastText("");
        toast({ title: "Message sent", description: "Everyone sees it on their table now." });
      },
      onError: (e) => toast({ title: "Failed to send", description: (e as Error).message, variant: "destructive" }),
    });
  };

  const copySessionCode = async () => {
    try {
      await navigator.clipboard.writeText((gameId ?? "").toUpperCase());
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    } catch {}
  };

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
      setLocation("/");
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
  if (currentUser?.role !== "facilitator" || currentUser.id !== gameState.facilitatorId) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-xl font-bold">Facilitator approval required</h1>
        <p className="text-sm text-muted-foreground">Sign in with the approved account that created this session.</p>
        <Button onClick={() => setLocation("/")}>Back to lobby</Button>
      </div>
    );
  }

  const paused = (gameState as any).paused === true;
  const decision = gameState.pendingDecision;
  const currentPlayer = gameState.players[gameState.currentPlayerIndex];
  const decisionOwner = decision ? gameState.players.find((p) => p.id === decision.playerId) : null;
  const isWaitingRoom = gameState.phase === "waiting";
  const displayedMaxPlayers = gameState.maxPlayers ?? 4;

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

  const handleKick = () => {
    if (!kickTarget) return;
    const { id, name } = kickTarget;
    kickMutation.mutate(id, {
      onSuccess: () => {
        setKickTarget(null);
        toast({
          title: `${name} removed`,
          description: isWaitingRoom ? "Their seat is now open." : "A bot has taken over their seat so the game can continue.",
        });
      },
      onError: (e) => toast({ title: "Could not remove player", description: (e as Error).message, variant: "destructive" }),
    });
  };

  const movePlayer = (index: number, direction: -1 | 1) => {
    const next = [...gameState.players];
    const target = index + direction;
    const firstMovableIndex = hostIsSpectator ? 0 : 1;
    if (index < firstMovableIndex || target < firstMovableIndex || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    // The legacy host occupies immutable seat 0; the reorder contract receives guests only.
    const guestIds = next.slice(firstMovableIndex).map((player) => player.id);
    reorderMutation.mutate(guestIds, {
      onError: (e) => toast({ title: "Couldn't reorder players", description: (e as Error).message, variant: "destructive" }),
    });
  };

  const startWaitingGame = () => {
    startMutation.mutate(undefined, {
      onError: (e) => toast({ title: "Can't start yet", description: (e as Error).message, variant: "destructive" }),
    });
  };

  const availableTransferRooms = facilitatorRooms.filter((room) => {
    const roomId = room.gameId ?? (room as any).id;
    return roomId !== gameId && (!(room as any).phase || (room as any).phase === "waiting") &&
      (!(room as any).mode || (room as any).mode === "facilitated");
  });

  return (
    <div className="min-h-screen bg-background game-table-pattern flex flex-col text-foreground">
      {/* Header */}
      <header className="shrink-0 flex items-center gap-2 px-3 py-2 bg-card/90 backdrop-blur-md border-b border-border z-20">
        <img src={compostHeroesLogo} alt="Compost Heroes" className="h-7 w-auto shrink-0" draggable={false} />
        <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30 rounded-full px-2.5 py-1 shrink-0">
          <Crown className="w-3.5 h-3.5" /> Facilitator
        </span>
        <button
          onClick={copySessionCode}
          title="Copy session code — participants enter this on the home page"
          className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-mono font-bold border bg-background/80 border-border text-foreground/80 hover:bg-muted/60 transition-colors shrink-0"
          data-testid="session-code"
        >
          {(gameId ?? "").toUpperCase()}
          {codeCopied ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3 opacity-60" />}
        </button>
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
        <Button
          size="sm"
          variant="ghost"
          className="h-8 px-2.5 rounded-full text-xs font-bold shrink-0"
          onClick={() => setLocation("/")}
          data-testid="button-back-lobby"
        >
          <ArrowLeft className="w-3.5 h-3.5 mr-1" /> <span className="hidden sm:inline">Lobby</span>
        </Button>
        {gameId && ((gameState as typeof gameState & { eventId?: string }).eventId || getGameEventId(gameId)) && (
          <Button size="sm" variant="outline" className="h-8 rounded-full text-xs font-bold shrink-0" onClick={() => setLocation(`/facilitator/events/${(gameState as typeof gameState & { eventId?: string }).eventId || getGameEventId(gameId)}`)} data-testid="button-back-to-event">
            <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back to Event
          </Button>
        )}
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
            <div className="flex-1" />
            {gameState.phase !== "game_over" && (
              confirmEnd ? (
                <span className="flex items-center gap-1.5">
                  <span className="text-xs font-bold text-destructive">End for everyone?</span>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="font-bold rounded-xl"
                    disabled={endMutation.isPending}
                    onClick={() =>
                      endMutation.mutate(undefined, {
                        onSuccess: () => { setConfirmEnd(false); toast({ title: "Session ended", description: "All tables see the final summary." }); },
                        onError: (e) => { setConfirmEnd(false); toast({ title: "Failed", description: (e as Error).message, variant: "destructive" }); },
                      })
                    }
                    data-testid="button-confirm-end"
                  >
                    {endMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Yes, end it"}
                  </Button>
                  <Button size="sm" variant="ghost" className="rounded-xl" onClick={() => setConfirmEnd(false)}>Cancel</Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="font-bold rounded-xl border-destructive/40 text-destructive hover:bg-destructive/10"
                  disabled={isWaitingRoom}
                  onClick={() => setConfirmEnd(true)}
                  data-testid="button-end-session"
                >
                  <Flag className="w-4 h-4 mr-1.5" /> End session
                </Button>
              )
            )}
          </div>

          {/* Broadcast a message to this table only */}
          <div className="flex items-center gap-2 bg-card/90 backdrop-blur-md border border-border rounded-2xl px-3 py-2">
            <Megaphone className="w-4 h-4 text-primary shrink-0" />
            <input
              value={broadcastText}
              onChange={(e) => setBroadcastText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSendBroadcast(); }}
              maxLength={300}
              placeholder="Message everyone at this table (e.g. '5 minutes left!')"
              className="flex-1 min-w-0 bg-transparent text-sm focus:outline-none placeholder:text-muted-foreground/60"
              data-testid="input-broadcast"
            />
            <Button
              size="sm"
              className="font-bold rounded-xl shrink-0"
              disabled={!broadcastText.trim() || messageMutation.isPending}
              onClick={handleSendBroadcast}
              data-testid="button-send-broadcast"
            >
              {messageMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Send className="w-4 h-4 mr-1.5" /> Send</>}
            </Button>
          </div>

          {/* Waiting-room host controls */}
          {isWaitingRoom && (
            <section className="bg-card/90 backdrop-blur-md border-2 border-primary/20 rounded-2xl p-3 sm:p-4 space-y-3" data-testid="facilitator-waiting-management">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-display font-bold text-base">Waiting room</h2>
                  <p className="text-xs text-muted-foreground">
                    {gameState.players.length} of {displayedMaxPlayers} participants seated · game starts with 2–{displayedMaxPlayers}
                  </p>
                </div>
                <Button
                  className="font-bold rounded-xl"
                  disabled={gameState.players.length < 2 || gameState.players.length > 4 || startMutation.isPending}
                  onClick={startWaitingGame}
                  data-testid="button-start-facilitated-game"
                >
                  {startMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
                  Start game ({gameState.players.length}/{displayedMaxPlayers})
                </Button>
              </div>
              {gameState.players.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
                  No participants yet. Share the session code or table link to invite players.
                </div>
              ) : (
                <div className="space-y-2">
                  {gameState.players.map((player, index) => (
                    <div key={player.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background/60 p-2.5" data-testid={`waiting-participant-${player.id}`}>
                      <span className="flex-1 min-w-[8rem] font-semibold text-sm">{index + 1}. {player.name}</span>
                      {!hostIsSpectator && index === 0 && (
                        <span className="rounded-full bg-amber-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                          Host · fixed seat
                        </span>
                      )}
                      {isFacilitated && (hostIsSpectator || index > 0) && (
                        <>
                          <div className="flex items-center">
                            <Button
                              size="icon"
                              variant="outline"
                              className="h-8 w-8 rounded-lg"
                              title="Move participant up"
                              aria-label={`Move ${player.name} up`}
                              disabled={index === (hostIsSpectator ? 0 : 1) || reorderMutation.isPending}
                              onClick={() => movePlayer(index, -1)}
                              data-testid={`button-reorder-up-${player.id}`}
                            ><ArrowUp className="w-4 h-4" /></Button>
                            <Button
                              size="icon"
                              variant="outline"
                              className="h-8 w-8 rounded-lg ml-1"
                              title="Move participant down"
                              aria-label={`Move ${player.name} down`}
                              disabled={index === gameState.players.length - 1 || reorderMutation.isPending}
                              onClick={() => movePlayer(index, 1)}
                              data-testid={`button-reorder-down-${player.id}`}
                            ><ArrowDown className="w-4 h-4" /></Button>
                          </div>
                          {availableTransferRooms.length > 0 && (
                            <div className="flex items-center gap-1.5 w-full sm:w-auto sm:ml-auto">
                              <select
                                id={`transfer-room-${player.id}`}
                                className="min-w-0 flex-1 sm:w-40 h-8 px-2 rounded-lg border border-border bg-background text-xs"
                                defaultValue=""
                                aria-label={`Transfer ${player.name} to another waiting room`}
                                data-testid={`select-transfer-room-${player.id}`}
                              >
                                <option value="" disabled>Destination room…</option>
                                {availableTransferRooms.map((room) => {
                                  const roomId = room.gameId ?? (room as any).id;
                                  return <option key={roomId} value={roomId}>{room.label || `Room ${roomId}`}</option>;
                                })}
                              </select>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 rounded-lg shrink-0"
                                disabled={transferMutation.isPending}
                                onClick={() => {
                                  const select = document.getElementById(`transfer-room-${player.id}`) as HTMLSelectElement | null;
                                  if (!select?.value) {
                                    toast({ title: "Choose a destination room first", variant: "destructive" });
                                    return;
                                  }
                                  transferMutation.mutate({ playerId: player.id, targetGameId: select.value }, {
                                    onSuccess: () => toast({ title: `${player.name} transferred`, description: "They'll be moved to the selected room." }),
                                    onError: (e) => toast({ title: "Transfer failed", description: (e as Error).message, variant: "destructive" }),
                                  });
                                }}
                                data-testid={`button-transfer-${player.id}`}
                              ><MoveRight className="w-3.5 h-3.5 mr-1" /> Transfer</Button>
                            </div>
                          )}
                          {!(player as any).isBot && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 rounded-lg text-destructive border-destructive/30 hover:bg-destructive/10"
                              onClick={() => setKickTarget({ id: player.id, name: player.name })}
                              data-testid={`button-remove-player-${player.id}`}
                            >
                              <UserX className="w-3.5 h-3.5 mr-1" /> Remove
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Participant questions */}
          {(gameState.questions ?? []).filter((q) => !q.resolved).length > 0 && (
            <div className="bg-orange-50 dark:bg-orange-950/20 border border-orange-200/70 dark:border-orange-800/40 rounded-2xl px-3 py-2 space-y-1.5">
              <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-orange-700 dark:text-orange-400">
                <HelpCircle className="w-3.5 h-3.5" /> Questions from participants
              </span>
              {(gameState.questions ?? []).filter((q) => !q.resolved).map((q) => (
                <div key={q.id} className="flex items-center gap-2 bg-card/80 rounded-xl px-3 py-1.5" data-testid={`question-${q.id}`}>
                  <span className="text-sm min-w-0 flex-1 truncate">
                    <strong className="text-foreground">{q.playerName}</strong>
                    <span className="text-muted-foreground"> {q.text ? `— ${q.text}` : "raised a hand"}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-xl font-bold shrink-0 h-7"
                    disabled={resolveQuestionMutation.isPending}
                    onClick={() =>
                      resolveQuestionMutation.mutate(q.id, {
                        onError: (e) => toast({ title: "Failed", description: (e as Error).message, variant: "destructive" }),
                      })
                    }
                  >
                    <Check className="w-3.5 h-3.5 mr-1" /> Done
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Post-session summary */}
          {gameState.phase === "game_over" && (
            <div className="bg-card/95 backdrop-blur-md border-2 border-primary/30 rounded-2xl px-4 py-3 space-y-2" data-testid="session-summary">
              <span className="flex items-center gap-2 text-sm font-extrabold text-foreground">
                <Trophy className="w-4 h-4 text-amber-500" />
                {gameState.winner
                  ? `${gameState.players.find((p) => p.id === gameState.winner)?.name ?? "Someone"} won the game!`
                  : "Session ended by facilitator"}
              </span>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {(() => {
                    const start = gameState.createdAt;
                    const end = gameState.endedAt ?? Date.now();
                    if (!start) return `${gameState.turnNumber} turns played`;
                    const mins = Math.max(1, Math.round((end - start) / 60000));
                    return `${mins} min · ${gameState.turnNumber} turns`;
                  })()}
                </span>
                {gameState.players.map((p) => (
                  <span key={p.id}>
                    <strong className="text-foreground">{p.name}</strong>: {collectedCategoryCount(p.compostPile)}/5 functions
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Player grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {gameState.players.map((player, idx) => {
              const isTurn = !isWaitingRoom && idx === gameState.currentPlayerIndex;
              const waitingOnThem = !!decision && decision.playerId === player.id;
              const collected = collectedCategoryCount(player.compostPile);
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
                        {idx === 0 && !hostIsSpectator && <Crown className="w-3 h-3 text-amber-500 shrink-0" />}
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

                  {/* Active-session participant controls */}
                  {(hostIsSpectator || idx !== 0) && !(player as any).isBot && !isWaitingRoom && gameState.phase !== "game_over" && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        className="font-bold rounded-xl h-7 text-xs"
                        disabled={nudgeMutation.isPending}
                        onClick={() => handleNudge(idx, player.name)}
                        data-testid={`button-nudge-${player.id}`}
                      >
                        <Bell className="w-3.5 h-3.5 mr-1" /> Nudge
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="font-bold rounded-xl h-7 text-xs text-destructive border-destructive/30 hover:bg-destructive/10"
                        onClick={() => setKickTarget({ id: player.id, name: player.name })}
                        data-testid={`button-remove-player-${player.id}`}
                      >
                        <UserX className="w-3.5 h-3.5 mr-1" /> Remove
                      </Button>
                    </div>
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
      <AlertDialog open={!!kickTarget} onOpenChange={(open) => { if (!open && !kickMutation.isPending) setKickTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {kickTarget?.name} from this table?</AlertDialogTitle>
            <AlertDialogDescription>
              {isWaitingRoom
                ? "They will lose access to this room and their seat will be available for someone else."
                : "They will immediately lose access to this game. A bot will take over their seat and keep their cards and pile so the game can continue."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={kickMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={kickMutation.isPending}
              onClick={(e) => { e.preventDefault(); handleKick(); }}
              data-testid="button-confirm-remove-player"
            >
              {kickMutation.isPending ? "Removing…" : "Remove player"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
