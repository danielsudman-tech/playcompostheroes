import { useState } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { useCreateNewGame, useRooms, type RoomInfo } from "@/hooks/use-game";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Users, Trash2, PlusCircle, Settings2, PlayCircle, Wifi, Lock,
  RefreshCcw, LogIn, ChevronRight, Loader2
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

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

  const [tab, setTab] = useState<"create" | "browse">("create");
  const [mode, setMode] = useState<"standalone" | "facilitator" | "online">("standalone");

  // Pass & Play / Facilitator fields
  const [players, setPlayers] = useState<string[]>(["Player 1", "Player 2"]);

  // Online (waiting room) fields
  const [hostName, setHostName] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [gamePassword, setGamePassword] = useState("");

  const handleAddPlayer = () => {
    if (players.length < 4) setPlayers([...players, `Player ${players.length + 1}`]);
  };
  const handleRemovePlayer = (i: number) => {
    if (players.length > 2) setPlayers(players.filter((_, idx) => idx !== i));
  };
  const handleUpdateName = (i: number, name: string) => {
    const next = [...players];
    next[i] = name;
    setPlayers(next);
  };

  const handleStartGame = () => {
    if (mode === "online") {
      const name = hostName.trim();
      if (!name) {
        toast({ title: "Enter your name", description: "You need a name to create the room.", variant: "destructive" });
        return;
      }
      createGame.mutate(
        { hostName: name, maxPlayers, mode: "online", password: gamePassword.trim() || undefined },
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
    createGame.mutate(
      { playerNames: validPlayers, mode },
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
        {/* Title */}
        <div className="text-center mb-6">
          <img
            src={`${import.meta.env.BASE_URL}assets/card-back.jpg`}
            alt="Compost Heroes"
            className="w-40 mx-auto rounded-2xl shadow-2xl ring-4 ring-primary/20 mb-3"
            draggable={false}
          />
          <p className="text-muted-foreground font-medium">The card game of soil and strategy</p>
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
                      <span className="text-[10px] opacity-80">Same device</span>
                    </button>
                    <button
                      onClick={() => setMode("online")}
                      className={`p-3 rounded-xl border-2 transition-all flex flex-col items-center text-center gap-1 ${mode === "online" ? "border-green-500 bg-green-500/10 text-green-600" : "border-border hover:border-green-500/50 text-muted-foreground"}`}
                    >
                      <Wifi className="w-4 h-4 shrink-0" />
                      <span className="font-bold text-sm">Online</span>
                      <span className="text-[10px] opacity-80">Share a link</span>
                    </button>
                    <button
                      onClick={() => setMode("facilitator")}
                      className={`p-3 rounded-xl border-2 transition-all flex flex-col items-center text-center gap-1 ${mode === "facilitator" ? "border-secondary bg-secondary/10 text-secondary" : "border-border hover:border-secondary/50 text-muted-foreground"}`}
                    >
                      <span className="font-bold text-sm">Facilitator</span>
                      <span className="text-[10px] opacity-80">Host view</span>
                    </button>
                  </div>
                </div>

                {/* Online: host name + max players + password */}
                {mode === "online" && (
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

                {/* Pass & Play / Facilitator: player names */}
                {mode !== "online" && (
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
                        <motion.div key={i} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="flex gap-2 items-center">
                          <Input
                            value={player}
                            onChange={(e) => handleUpdateName(i, e.target.value)}
                            placeholder={`Player ${i + 1}`}
                            className="h-12 bg-background/50 border-2 focus-visible:ring-primary/20 text-lg font-medium"
                          />
                          {players.length > 2 && (
                            <Button
                              variant="outline"
                              className="h-12 w-12 shrink-0 text-destructive hover:bg-destructive/10 hover:border-destructive"
                              onClick={() => handleRemovePlayer(i)}
                            >
                              <Trash2 className="w-5 h-5" />
                            </Button>
                          )}
                        </motion.div>
                      ))}
                    </div>
                  </div>
                )}

                <Button
                  size="lg"
                  className="w-full h-14 text-xl font-display tracking-wide rounded-xl shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 hover:-translate-y-1 transition-all"
                  onClick={handleStartGame}
                  disabled={createGame.isPending}
                >
                  {createGame.isPending ? (mode === "online" ? "Creating room…" : "Setting up pile…") : (
                    <span className="flex items-center gap-2">
                      {mode === "online" ? <Wifi className="w-6 h-6" /> : <PlayCircle className="w-6 h-6" />}
                      {mode === "online" ? "Create Room" : "Start Game"}
                    </span>
                  )}
                </Button>
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

        <div className="mt-5 text-center">
          <p className="text-sm text-muted-foreground">Collect 1 Hero from each of the 5 layers to win!</p>
          <a href={`${import.meta.env.BASE_URL}admin`} className="text-xs text-muted-foreground/40 hover:text-muted-foreground transition-colors mt-2 inline-block">
            Card Image Admin
          </a>
        </div>
      </motion.div>
    </div>
  );
}
