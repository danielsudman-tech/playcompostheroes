import { useState } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { useCreateNewGame } from "@/hooks/use-game";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sprout, Users, Trash2, PlusCircle, Settings2, PlayCircle, Wifi, Copy, Check, Lock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function Lobby() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createGame = useCreateNewGame();
  
  const [mode, setMode] = useState<"standalone" | "facilitator" | "online">("standalone");
  const [players, setPlayers] = useState<string[]>(["Player 1", "Player 2"]);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [gamePassword, setGamePassword] = useState("");

  const handleAddPlayer = () => {
    if (players.length < 4) {
      setPlayers([...players, `Player ${players.length + 1}`]);
    }
  };

  const handleRemovePlayer = (index: number) => {
    if (players.length > 2) {
      setPlayers(players.filter((_, i) => i !== index));
    }
  };

  const handleUpdateName = (index: number, name: string) => {
    const newPlayers = [...players];
    newPlayers[index] = name;
    setPlayers(newPlayers);
  };

  const handleCopyLink = () => {
    if (!shareLink) return;
    navigator.clipboard.writeText(shareLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleStartGame = () => {
    const validPlayers = players.filter(p => p.trim() !== "");
    if (validPlayers.length < 2) {
      toast({
        title: "Not enough players",
        description: "You need at least 2 players to start.",
        variant: "destructive"
      });
      return;
    }

    createGame.mutate({
      playerNames: validPlayers,
      mode: mode,
      password: mode === "online" && gamePassword.trim() ? gamePassword.trim() : undefined,
    }, {
      onSuccess: (data) => {
        if (mode === "online") {
          const link = `${window.location.origin}${import.meta.env.BASE_URL}game/${data.gameId}`.replace(/\/+$/, "");
          setShareLink(link);
        } else {
          setLocation(`/game/${data.gameId}`);
        }
      },
      onError: (err) => {
        toast({
          title: "Failed to create game",
          description: err.message,
          variant: "destructive"
        });
      }
    });
  };

  // Online mode — show the share link screen after game creation
  if (shareLink) {
    const gameId = shareLink.split("/").pop();
    return (
      <div className="min-h-screen bg-background relative overflow-hidden flex flex-col items-center justify-center p-4">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 blur-[100px] rounded-full pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-secondary/20 blur-[120px] rounded-full pointer-events-none" />

        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="relative z-10 w-full max-w-md"
        >
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-20 h-20 bg-green-500/10 rounded-full mb-4 ring-8 ring-green-500/5">
              <Wifi className="w-10 h-10 text-green-500" />
            </div>
            <h1 className="text-4xl font-display font-bold text-foreground mb-2">Game Created!</h1>
            <p className="text-muted-foreground">Share this link with your players.</p>
          </div>

          <div className="bg-card/80 backdrop-blur-xl rounded-3xl shadow-xl border border-border p-6 space-y-6">
            <div>
              <label className="text-sm font-bold text-muted-foreground uppercase tracking-wider mb-3 block">Share Link</label>
              <div className="flex gap-2">
                <Input
                  value={shareLink}
                  readOnly
                  className="h-12 bg-background/50 border-2 font-mono text-sm select-all"
                  onClick={e => (e.target as HTMLInputElement).select()}
                />
                <Button
                  variant="outline"
                  className="h-12 w-12 shrink-0"
                  onClick={handleCopyLink}
                >
                  {copied ? <Check className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5" />}
                </Button>
              </div>
            </div>

            {gamePassword.trim() && (
              <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-2xl p-4">
                <Lock className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-amber-800">Password protected</p>
                  <p className="text-xs text-amber-700 mt-0.5">Players will need the password you set to join. Share it alongside the link.</p>
                </div>
              </div>
            )}

            <div className="bg-muted/40 rounded-2xl p-4 space-y-2">
              <p className="text-sm font-semibold text-foreground">How it works</p>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• You are <strong>Player 1</strong> — open your game below</li>
                <li>• Each player opens the link on their own device</li>
                <li>• Players are assigned slots in the order they join</li>
                <li>• Everyone sees their own hand privately</li>
              </ul>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="outline"
                className="h-12"
                onClick={() => { setShareLink(null); }}
              >
                Back
              </Button>
              <Button
                className="h-12"
                onClick={() => setLocation(`/game/${gameId}`)}
              >
                Open My Game
              </Button>
            </div>
          </div>
        </motion.div>
      </div>
    );
  }

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
          <h1 className="text-6xl font-display font-bold text-foreground drop-shadow-sm mb-2">Compost<br/><span className="text-primary">Heroes</span></h1>
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
            {mode === "online" && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground bg-muted/40 rounded-xl px-3 py-2">
                  Set all player names now. After creating, you'll get a link to share — each player opens it on their own device.
                </p>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
                  <Input
                    type="password"
                    placeholder="Game password (optional)"
                    value={gamePassword}
                    onChange={(e) => setGamePassword(e.target.value)}
                    className="h-11 pl-9 bg-background/50 border-2 focus-visible:ring-primary/20 text-sm"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Players */}
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
                  {mode === "online" && (
                    <span className="text-xs text-muted-foreground w-16 shrink-0 text-right font-medium">
                      {index === 0 ? "You →" : `P${index + 1} →`}
                    </span>
                  )}
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

          <Button 
            size="lg" 
            className="w-full h-14 text-xl font-display tracking-wide rounded-xl shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 hover:-translate-y-1 transition-all"
            onClick={handleStartGame}
            disabled={createGame.isPending}
          >
            {createGame.isPending ? "Setting up pile..." : (
              <span className="flex items-center gap-2">
                {mode === "online" ? <Wifi className="w-6 h-6" /> : <PlayCircle className="w-6 h-6" />}
                {mode === "online" ? "Create Online Game" : "Start Game"}
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
