import { useState } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { useCreateNewGame } from "@/hooks/use-game";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sprout, Users, Trash2, PlusCircle, Settings2, PlayCircle, Wifi, Lock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function Lobby() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createGame = useCreateNewGame();

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

  const handleRemovePlayer = (index: number) => {
    if (players.length > 2) setPlayers(players.filter((_, i) => i !== index));
  };

  const handleUpdateName = (index: number, name: string) => {
    const next = [...players];
    next[index] = name;
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

    const validPlayers = players.filter((p) => p.trim() !== "");
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
        <img src={`${import.meta.env.BASE_URL}images/wood-bg.png`} alt="wood texture" className="w-full h-full object-cover" />
      </div>

      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 blur-[100px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-secondary/20 blur-[120px] rounded-full pointer-events-none" />

      <motion.div
        initial={{ y: -50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.8, type: "spring" }}
        className="relative z-10 w-full max-w-md"
      >
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-24 h-24 bg-primary/10 rounded-full mb-4 ring-8 ring-primary/5">
            <Sprout className="w-12 h-12 text-primary" />
          </div>
          <h1 className="text-6xl font-display font-bold text-foreground drop-shadow-sm mb-2">
            Compost<br /><span className="text-primary">Heroes</span>
          </h1>
          <p className="text-muted-foreground text-lg font-medium">The card game of soil and strategy</p>
        </div>

        <div className="bg-card/80 backdrop-blur-xl rounded-3xl shadow-xl border border-border p-6 sm:p-8 space-y-8">

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
              <p className="text-xs text-muted-foreground bg-muted/40 rounded-xl px-3 py-2">
                Create a room and share the link — other players join by entering their own name on their device.
              </p>
              <Input
                placeholder="Your name (host)"
                value={hostName}
                onChange={(e) => setHostName(e.target.value)}
                className="h-12 bg-background/50 border-2 focus-visible:ring-primary/20 text-base font-medium"
                autoFocus
              />
              <div className="space-y-2">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                  <Users className="w-3.5 h-3.5" /> Max players
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[2, 3, 4].map((n) => (
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
                {players.map((player, index) => (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="flex gap-2 items-center"
                  >
                    <Input
                      value={player}
                      onChange={(e) => handleUpdateName(index, e.target.value)}
                      placeholder={`Player ${index + 1}`}
                      className="h-12 bg-background/50 border-2 focus-visible:ring-primary/20 text-lg font-medium"
                    />
                    {players.length > 2 && (
                      <Button
                        variant="outline"
                        className="h-12 w-12 shrink-0 text-destructive hover:bg-destructive/10 hover:border-destructive"
                        onClick={() => handleRemovePlayer(index)}
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
            {createGame.isPending ? (mode === "online" ? "Creating room..." : "Setting up pile...") : (
              <span className="flex items-center gap-2">
                {mode === "online" ? <Wifi className="w-6 h-6" /> : <PlayCircle className="w-6 h-6" />}
                {mode === "online" ? "Create Room" : "Start Game"}
              </span>
            )}
          </Button>

        </div>

        <div className="mt-6 text-center">
          <p className="text-sm text-muted-foreground">
            Collect 1 Hero from each of the 5 layers to win!
          </p>
          <a href={`${import.meta.env.BASE_URL}admin`} className="text-xs text-muted-foreground/40 hover:text-muted-foreground transition-colors mt-3 inline-block">
            Card Image Admin
          </a>
        </div>
      </motion.div>
    </div>
  );
}
