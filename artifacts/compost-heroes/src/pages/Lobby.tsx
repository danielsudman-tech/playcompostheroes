import { useState } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { useCreateNewGame, useRooms, type RoomInfo } from "@/hooks/use-game";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TurnTimerSelect } from "@/components/TurnTimerChip";
import { assetUrl } from "@/lib/assetUrl";
import compostHeroesLogo from "@assets/Compost_Heroes_Logo_no_background_1773537933517.png";
import greenCampsLogo from "@assets/Green_Camps_Logo_no_background_1774982775801.png";
import {
  Users, Trash2, PlusCircle, Settings2, PlayCircle, Wifi, Lock,
  RefreshCcw, LogIn, ChevronRight, Loader2, Bot, User, ShoppingCart, LogOut,
  Monitor, KeyRound, Crown
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser, useLogout } from "@/components/AppGate";
import { getPublicEvent } from "@workspace/api-client-react";
import { GREEN_CAMPS_URL, PHYSICAL_GAME_URL } from "@/lib/links";

// ── Room Browser ────────────────────────────────────────────────────────────

function RoomCard({ room, onJoin }: { room: RoomInfo; onJoin: (gameId: string) => void }) {
  const full = room.playerCount >= room.maxPlayers;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex items-center gap-3 rounded-2xl border-2 px-4 py-3 transition-all ${full ? "border-border opacity-60" : "border-border hover:border-primary/50 hover:bg-primary/3"}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="font-semibold text-sm text-foreground truncate">{room.hostName}'s room</span>
          {room.hasPassword && (
            <span className="flex items-center gap-0.5 text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5 font-bold shrink-0">
              <Lock className="w-2.5 h-2.5" /> Locked
            </span>
          )}
          {full && (
            <span className="text-[10px] text-muted-foreground bg-muted rounded-full px-1.5 py-0.5 font-medium shrink-0">Full</span>
          )}
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Users className="w-3 h-3" />
          <span>{room.playerCount} / {room.maxPlayers} players</span>
          <span className="mx-1">·</span>
          <span className="font-mono text-[10px] opacity-70">{room.gameId.toUpperCase()}</span>
        </div>
      </div>
      <button
        disabled={full}
        onClick={() => onJoin(room.gameId)}
        className="flex items-center gap-1 text-xs font-bold text-primary bg-primary/10 hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl px-3 py-2 transition-colors shrink-0"
      >
        {full ? "Full" : <><LogIn className="w-3.5 h-3.5" /> Join</>}
      </button>
    </motion.div>
  );
}

function RoomBrowser() {
  const [, setLocation] = useLocation();
  const { data: rooms, isLoading, refetch, isFetching } = useRooms();

  const openRooms = (rooms ?? []).filter(r => r.playerCount < r.maxPlayers);
  const fullRooms = (rooms ?? []).filter(r => r.playerCount >= r.maxPlayers);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {isLoading ? "Looking for rooms…" : openRooms.length === 0 ? "No open rooms right now." : `${openRooms.length} open room${openRooms.length !== 1 ? "s" : ""} available`}
        </p>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCcw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-2">
          {openRooms.map(r => (
            <RoomCard key={r.gameId} room={r} onJoin={id => setLocation(`/game/${id}`)} />
          ))}
          {fullRooms.map(r => (
            <RoomCard key={r.gameId} room={r} onJoin={id => setLocation(`/game/${id}`)} />
          ))}
          {(rooms ?? []).length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <Users className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No rooms yet. Create one!</p>
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground text-center">Refreshes automatically every 5 seconds.</p>
    </div>
  );
}

// ── Main Lobby ──────────────────────────────────────────────────────────────

export default function Lobby() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createGame = useCreateNewGame();
  const currentUser = useCurrentUser();
  const logout = useLogout();

  const [tab, setTab] = useState<"create" | "browse">("create");
  const [mode, setMode] = useState<"standalone" | "online" | "facilitated">("standalone");

  type SkillLevel = "easy" | "medium" | "hard";

  // Pass & Play / Facilitator fields
  const [players, setPlayers] = useState<string[]>(["Player 1", "Player 2"]);
  const [botPlayers, setBotPlayers] = useState<boolean[]>([false, false]);
  const [botSkillLevels, setBotSkillLevels] = useState<SkillLevel[]>(["medium", "medium"]);

  // Online (waiting room) fields
  const [hostName, setHostName] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [gamePassword, setGamePassword] = useState("");
  const [turnTimerSeconds, setTurnTimerSeconds] = useState(0);

  // Facilitated: participants join with a code; hosts use /facilitator.
  const [joinCode, setJoinCode] = useState("");
  const [joiningCode, setJoiningCode] = useState(false);

  const requestSignIn = () => {
    window.location.search = "signin=1";
  };

  const handleJoinWithCode = async () => {
    const code = joinCode.trim().toLowerCase();
    if (!code) {
      toast({ title: "Enter your code", description: "Ask your facilitator for the session code.", variant: "destructive" });
      return;
    }
    setJoiningCode(true);
    try {
      try {
        await getPublicEvent(code);
        setLocation(`/event/${code}`);
        return;
      } catch (eventError) {
        if ((eventError as { status?: number }).status !== 404) throw eventError;
      }
      const r = await fetch(`/api/games/${encodeURIComponent(code)}`);
      if (!r.ok) throw new Error("not found");
      const game = await r.json() as { mode?: string };
      if (game.mode !== "facilitated") throw new Error("not facilitated");
      setLocation(`/game/${code}/table`);
    } catch {
      toast({ title: "Session not found", description: "Double-check the code with your facilitator.", variant: "destructive" });
    } finally {
      setJoiningCode(false);
    }
  };

  const handleAddPlayer = () => {
    if (players.length < 4) {
      setPlayers([...players, `Player ${players.length + 1}`]);
      setBotPlayers([...botPlayers, false]);
      setBotSkillLevels([...botSkillLevels, "medium"]);
    }
  };
  const handleRemovePlayer = (i: number) => {
    if (players.length > 2) {
      setPlayers(players.filter((_, idx) => idx !== i));
      setBotPlayers(botPlayers.filter((_, idx) => idx !== i));
      setBotSkillLevels(botSkillLevels.filter((_, idx) => idx !== i));
    }
  };
  const handleUpdateName = (i: number, name: string) => {
    const next = [...players];
    next[i] = name;
    setPlayers(next);
  };
  const handleToggleBot = (i: number) => {
    const humanCount = botPlayers.filter((b) => !b).length;
    if (!botPlayers[i] && humanCount <= 1) {
      toast({ title: "Need at least 1 human player", description: "You can't make everyone a bot.", variant: "destructive" });
      return;
    }
    const next = [...botPlayers];
    next[i] = !next[i];
    setBotPlayers(next);
    // If toggling to bot, give a default bot name
    if (next[i] && players[i].startsWith("Player ")) {
      const nameCopy = [...players];
      nameCopy[i] = `Bot ${i + 1}`;
      setPlayers(nameCopy);
    }
  };
  const handleSetBotSkill = (i: number, level: SkillLevel) => {
    const next = [...botSkillLevels];
    next[i] = level;
    setBotSkillLevels(next);
  };

  const handleStartGame = () => {
    if (mode === "online" || mode === "facilitated") {
      const name = hostName.trim();
      if (!name) {
        toast({ title: "Enter your name", description: "You need a name to create the room.", variant: "destructive" });
        return;
      }
      createGame.mutate(
        { hostName: name, maxPlayers, mode, password: gamePassword.trim() || undefined, ...(mode === "online" && turnTimerSeconds > 0 ? { turnTimerSeconds } : {}) },
        {
          onSuccess: (data) => setLocation(`/game/${data.gameId}`),
          onError: (err) => toast({ title: "Failed to create room", description: err.message, variant: "destructive" }),
        }
      );
      return;
    }

    const validPlayers = players.filter(p => p.trim() !== "");
    if (validPlayers.length < 2) {
      toast({ title: "Not enough players", description: "You need at least 2 players to start.", variant: "destructive" });
      return;
    }
    const botPlayerIndices = botPlayers
      .map((isBot, i) => (isBot ? i : -1))
      .filter((i) => i >= 0);
    const skillLevels: Record<number, SkillLevel> = {};
    botPlayerIndices.forEach((i) => { skillLevels[i] = botSkillLevels[i] ?? "medium"; });
    createGame.mutate(
      { playerNames: validPlayers, mode, botPlayerIndices, botSkillLevels: skillLevels },
      {
        onSuccess: (data) => setLocation(`/game/${data.gameId}`),
        onError: (err) => toast({ title: "Failed to create game", description: err.message, variant: "destructive" }),
      }
    );
  };

  return (
    <div className="min-h-screen bg-background relative overflow-hidden flex flex-col items-center justify-center p-4">
      <div className="absolute inset-0 z-0 opacity-[0.03] pointer-events-none mix-blend-multiply">
        <img src={`${import.meta.env.BASE_URL}images/wood-bg.png`} alt="" className="w-full h-full object-cover" />
      </div>
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 blur-[100px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-secondary/20 blur-[120px] rounded-full pointer-events-none" />

      <motion.div
        initial={{ y: -40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.7, type: "spring" }}
        className="relative z-10 w-full max-w-md"
      >
        {/* Account and host navigation */}
        <div className="flex items-center justify-between gap-2 mb-4 px-1">
          {currentUser ? (
            <>
              <span className="flex items-center gap-1.5 min-w-0 text-sm text-muted-foreground">
                <User className="w-3.5 h-3.5 shrink-0" />
                <span className="font-medium text-foreground truncate">{currentUser.name}</span>
              </span>
              <div className="flex items-center gap-3 shrink-0">
                {currentUser.role === "facilitator" && (
                  <button
                    onClick={() => setLocation("/facilitator")}
                    className="flex items-center gap-1 text-xs font-bold text-primary hover:underline underline-offset-2"
                  >
                    <Crown className="w-3.5 h-3.5" /> Host Panel
                  </button>
                )}
                <button
                  onClick={logout}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors font-medium"
                >
                  <LogOut className="w-3.5 h-3.5" /> Sign out
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="text-xs text-muted-foreground">Playing as a guest</span>
              <button
                onClick={requestSignIn}
                className="flex items-center gap-1.5 text-sm font-bold text-primary hover:underline underline-offset-2"
              >
                <LogIn className="w-4 h-4" /> Sign in / Create account
              </button>
            </>
          )}
        </div>

        {/* Title */}
        <div className="text-center mb-6">
          <img
            src={compostHeroesLogo}
            alt="Compost Heroes"
            className="w-72 mx-auto mb-2 drop-shadow-xl"
            draggable={false}
          />
          <p className="text-muted-foreground font-medium mb-3">The card game of soil and strategy</p>
          <div className="flex items-center justify-center gap-2 opacity-70">
            <span className="text-xs text-muted-foreground font-medium tracking-wide">A Project of</span>
            <a href={GREEN_CAMPS_URL} target="_blank" rel="noopener noreferrer">
              <img
                src={greenCampsLogo}
                alt="Green Camps"
                className="h-7 object-contain hover:opacity-80 transition-opacity"
                draggable={false}
              />
            </a>
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex rounded-2xl bg-muted/50 p-1 mb-4 border border-border gap-1">
          {(["create", "browse"] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${tab === t ? "bg-card shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {t === "create" ? (
                <span className="flex items-center justify-center gap-1.5"><PlusCircle className="w-3.5 h-3.5" /> Create</span>
              ) : (
                <span className="flex items-center justify-center gap-1.5"><ChevronRight className="w-3.5 h-3.5" /> Browse Rooms</span>
              )}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {tab === "create" ? (
            <motion.div
              key="create"
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 16 }}
              transition={{ duration: 0.2 }}
            >
              <div className="bg-card/80 backdrop-blur-xl rounded-3xl shadow-xl border border-border p-6 sm:p-8 space-y-6">

                {/* Mode Selection */}
                <div className="space-y-3">
                  <label className="text-sm font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                    <Settings2 className="w-4 h-4" /> Game Mode
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => setMode("standalone")}
                      className={`p-3 rounded-xl border-2 transition-all flex flex-col items-center text-center gap-1 ${mode === "standalone" ? "border-primary bg-primary/10 text-primary" : "border-border hover:border-primary/50 text-muted-foreground"}`}
                    >
                      <span className="font-bold text-sm">Pass & Play</span>
                      <span className="text-[10px] opacity-80">Same device, no sign-up</span>
                    </button>
                    <button
                      onClick={() => setMode("online")}
                      className={`p-3 rounded-xl border-2 transition-all flex flex-col items-center text-center gap-1 ${mode === "online" ? "border-green-500 bg-green-500/10 text-green-600" : "border-border hover:border-green-500/50 text-muted-foreground"}`}
                    >
                      <Wifi className="w-4 h-4 shrink-0" />
                      <span className="font-bold text-sm">Online</span>
                      <span className="text-[10px] opacity-80">Share a link, sign-up required</span>
                    </button>
                    <button
                      onClick={() => setMode("facilitated")}
                      className={`p-3 rounded-xl border-2 transition-all flex flex-col items-center text-center gap-1 ${mode === "facilitated" ? "border-amber-500 bg-amber-500/10 text-amber-600" : "border-border hover:border-amber-500/50 text-muted-foreground"}`}
                    >
                      <Users className="w-4 h-4 shrink-0" />
                      <span className="font-bold text-sm">Facilitated</span>
                      <span className="text-[10px] opacity-80">Join with a code</span>
                      <span className="flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide bg-muted text-muted-foreground rounded-full px-1.5 py-0.5">
                        <Monitor className="w-2.5 h-2.5" /> Desktop
                      </span>
                    </button>
                  </div>
                </div>

                {/* Facilitated: join with a code (participants) */}
                {mode === "facilitated" && (
                  <div className="space-y-4">
                    <div className="text-center space-y-1">
                      <h3 className="font-bold text-lg text-foreground">Have a code from your facilitator?</h3>
                      <p className="text-xs text-muted-foreground">Enter it below to join the session — no account needed.</p>
                    </div>
                    <div className="relative">
                      <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
                      <Input
                        placeholder="Session code"
                        value={joinCode}
                        onChange={(e) => setJoinCode(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleJoinWithCode(); }}
                        className="h-12 pl-9 bg-background/50 border-2 focus-visible:ring-primary/20 text-base font-medium tracking-wider uppercase placeholder:normal-case placeholder:tracking-normal"
                        autoFocus
                      />
                    </div>
                    <Button
                      size="lg"
                      className="w-full h-14 text-xl font-display tracking-wide rounded-xl shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 hover:-translate-y-1 transition-all"
                      onClick={handleJoinWithCode}
                      disabled={joiningCode}
                    >
                      {joiningCode ? "Finding your session…" : (
                        <span className="flex items-center gap-2"><LogIn className="w-6 h-6" /> Join Session</span>
                      )}
                    </Button>
                    {currentUser?.role !== "facilitator" && (
                      <p className="text-center text-xs text-muted-foreground">
                        Want to host? Ask an administrator to approve your account as a facilitator.
                      </p>
                    )}
                  </div>
                )}

                {/* Online requires an account */}
                {mode === "online" && !currentUser && (
                  <div className="space-y-4 text-center">
                    <p className="text-sm text-muted-foreground bg-green-50 dark:bg-green-950/20 border border-green-200/60 rounded-lg p-3 leading-snug">
                      Online games need a free account so friends can find your room and rejoin if they disconnect.
                    </p>
                    <Button size="lg" className="w-full h-12 rounded-xl font-bold" onClick={requestSignIn}>
                      Sign in to play online
                    </Button>
                  </div>
                )}

                {/* Online host: name + max players + password */}
                {mode === "online" && !!currentUser && (
                  <div className="space-y-4">
                    <label className="text-sm font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                      <Wifi className="w-4 h-4" /> Your Room
                    </label>
                    <Input
                      placeholder="Your name (host)"
                      value={hostName}
                      onChange={(e) => setHostName(e.target.value)}
                      className="h-12 bg-background/50 border-2 focus-visible:ring-primary/20 text-base font-medium"
                      autoFocus
                    />
                    <div className="space-y-2">
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                        <Users className="w-3.5 h-3.5" /> Max players
                      </label>
                      <div className="grid grid-cols-3 gap-2">
                        {[2, 3, 4].map(n => (
                          <button
                            key={n}
                            onClick={() => setMaxPlayers(n)}
                            className={`py-2 rounded-xl border-2 text-sm font-bold transition-all ${maxPlayers === n ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}
                          >
                            {n} players
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="lobby-turn-timer" className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Turn timer</label>
                      <TurnTimerSelect value={turnTimerSeconds} onChange={setTurnTimerSeconds} testId="select-lobby-turn-timer" />
                    </div>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
                      <Input
                        type="password"
                        placeholder="Room password (optional)"
                        value={gamePassword}
                        onChange={(e) => setGamePassword(e.target.value)}
                        className="h-11 pl-9 bg-background/50 border-2 focus-visible:ring-primary/20 text-sm"
                      />
                    </div>
                  </div>
                )}

                {/* Pass & Play: player names */}
                {mode === "standalone" && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                        <Users className="w-4 h-4" /> Players ({players.length}/4)
                      </label>
                      {players.length < 4 && (
                        <Button variant="ghost" size="sm" onClick={handleAddPlayer} className="h-8 text-primary hover:text-primary hover:bg-primary/10">
                          <PlusCircle className="w-4 h-4 mr-1" /> Add
                        </Button>
                      )}
                    </div>
                    <div className="space-y-3">
                      {players.map((player, i) => (
                        <motion.div key={i} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="space-y-1.5">
                          <div className="flex gap-2 items-center">
                            <div className="relative flex-1">
                              <Input
                                value={player}
                                onChange={(e) => handleUpdateName(i, e.target.value)}
                                placeholder={`Player ${i + 1}`}
                                disabled={botPlayers[i]}
                                className={`h-12 border-2 focus-visible:ring-primary/20 text-lg font-medium transition-colors ${
                                  botPlayers[i]
                                    ? "bg-violet-50 dark:bg-violet-950/20 border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300"
                                    : "bg-background/50"
                                }`}
                              />
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              title={botPlayers[i] ? "Switch to human player" : "Switch to bot player"}
                              className={`h-12 w-12 shrink-0 transition-all ${
                                botPlayers[i]
                                  ? "border-violet-400 bg-violet-100 dark:bg-violet-950/30 text-violet-600 dark:text-violet-400 hover:bg-violet-200 dark:hover:bg-violet-900/40"
                                  : "border-border text-muted-foreground hover:border-primary/50 hover:text-primary"
                              }`}
                              onClick={() => handleToggleBot(i)}
                            >
                              {botPlayers[i] ? <Bot className="w-5 h-5" /> : <User className="w-5 h-5" />}
                            </Button>
                            {players.length > 2 && (
                              <Button
                                variant="outline"
                                className="h-12 w-12 shrink-0 text-destructive hover:bg-destructive/10 hover:border-destructive"
                                onClick={() => handleRemovePlayer(i)}
                              >
                                <Trash2 className="w-5 h-5" />
                              </Button>
                            )}
                          </div>
                          {botPlayers[i] && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: "auto" }}
                              exit={{ opacity: 0, height: 0 }}
                              className="flex gap-1 pl-0.5"
                            >
                              {(["easy", "medium", "hard"] as const).map((lvl) => {
                                const active = (botSkillLevels[i] ?? "medium") === lvl;
                                const labels: Record<string, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };
                                const colors: Record<string, string> = {
                                  easy: active ? "border-green-400 bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400" : "border-border text-muted-foreground hover:border-green-300 hover:text-green-600",
                                  medium: active ? "border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400" : "border-border text-muted-foreground hover:border-amber-300 hover:text-amber-600",
                                  hard: active ? "border-red-400 bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400" : "border-border text-muted-foreground hover:border-red-300 hover:text-red-600",
                                };
                                return (
                                  <button
                                    key={lvl}
                                    onClick={() => handleSetBotSkill(i, lvl)}
                                    className={`flex-1 py-1 rounded-lg border text-xs font-bold transition-all ${colors[lvl]}`}
                                  >
                                    {labels[lvl]}
                                  </button>
                                );
                              })}
                            </motion.div>
                          )}
                        </motion.div>
                      ))}
                    </div>
                  </div>
                )}

                {(mode === "standalone" || (mode === "online" && !!currentUser)) && (
                  <Button
                    size="lg"
                    className="w-full h-14 text-xl font-display tracking-wide rounded-xl shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 hover:-translate-y-1 transition-all"
                    onClick={handleStartGame}
                    disabled={createGame.isPending}
                  >
                    {createGame.isPending ? (mode === "standalone" ? "Setting up pile…" : "Creating room…") : (
                      <span className="flex items-center gap-2">
                        {mode === "standalone" ? <PlayCircle className="w-6 h-6" /> : <Wifi className="w-6 h-6" />}
                        {mode === "standalone" ? "Start Game" : "Create Room"}
                      </span>
                    )}
                  </Button>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="browse"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.2 }}
            >
              <div className="bg-card/80 backdrop-blur-xl rounded-3xl shadow-xl border border-border p-6">
                <RoomBrowser />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mt-5 flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground text-center">Collect 1 Hero from each of the 5 layers to win!</p>
          <a
            href={PHYSICAL_GAME_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 border-2 border-primary/40 text-primary hover:bg-primary/10 rounded-full px-4 py-2 text-sm font-semibold transition-colors"
          >
            <ShoppingCart className="w-4 h-4" />
            Buy the physical deck
          </a>
        </div>
      </motion.div>
    </div>
  );
}
