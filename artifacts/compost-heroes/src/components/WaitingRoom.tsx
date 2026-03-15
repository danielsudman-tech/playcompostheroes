import { useState } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { useStartGame, useLeaveRoom } from "@/hooks/use-game";
import { useToast } from "@/hooks/use-toast";
import { Copy, Check, Crown, Loader2, Users, Lock, LogOut, UserX, Bot, Plus, X } from "lucide-react";
import { assetUrl } from "@/lib/assetUrl";

interface PlayerSlot {
  id: string;
  name: string;
}

export interface BotSlot {
  name: string;
  skillLevel: "easy" | "medium" | "hard";
}

interface WaitingRoomProps {
  gameId: string;
  players: PlayerSlot[];
  maxPlayers: number;
  playerIndex: number | null;
  token: string | null;
  hasPassword?: boolean;
}

const SKILL_COLORS: Record<string, string> = {
  easy: "text-green-600 bg-green-50 border-green-200 hover:bg-green-100",
  medium: "text-amber-600 bg-amber-50 border-amber-200 hover:bg-amber-100",
  hard: "text-red-600 bg-red-50 border-red-200 hover:bg-red-100",
};

const SKILL_LABELS: Record<string, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

const BOT_NAMES = ["Compost Carl", "Worm Wendy", "Rot Rita", "Pile Pete", "Mulch Max", "Decay Dana"];

export function WaitingRoom({ gameId, players, maxPlayers, playerIndex, token, hasPassword }: WaitingRoomProps) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [botSlots, setBotSlots] = useState<BotSlot[]>([]);
  const startGame = useStartGame(gameId, token);
  const leaveRoom = useLeaveRoom(gameId, token);

  const isHost = playerIndex === 0;
  const myPlayerId = playerIndex !== null ? players[playerIndex]?.id : null;
  const shareUrl = `${window.location.origin}${import.meta.env.BASE_URL}game/${gameId}`.replace(/\/+\//, "/");
  const roomCode = gameId.toUpperCase();

  const totalCount = players.length + botSlots.length;
  const emptySlots = Math.max(0, maxPlayers - totalCount);
  const canStart = isHost && totalCount >= 2;

  const handleCopy = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleAddBot = () => {
    if (totalCount >= maxPlayers) return;
    const botNumber = botSlots.length + 1;
    const defaultName = BOT_NAMES[(botSlots.length) % BOT_NAMES.length] ?? `Bot ${botNumber}`;
    setBotSlots((prev) => [...prev, { name: defaultName, skillLevel: "medium" }]);
  };

  const handleRemoveBot = (idx: number) => {
    setBotSlots((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleBotSkill = (idx: number, level: "easy" | "medium" | "hard") => {
    setBotSlots((prev) => prev.map((b, i) => i === idx ? { ...b, skillLevel: level } : b));
  };

  const handleBotName = (idx: number, name: string) => {
    setBotSlots((prev) => prev.map((b, i) => i === idx ? { ...b, name } : b));
  };

  const handleStart = () => {
    startGame.mutate(botSlots.length > 0 ? botSlots : undefined, {
      onError: (err) => toast({ title: "Can't start yet", description: err.message, variant: "destructive" }),
    });
  };

  const handleLeave = () => {
    if (!myPlayerId) {
      setLocation("/");
      return;
    }
    leaveRoom.mutate(myPlayerId, {
      onSuccess: () => setLocation("/"),
      onError: (err) => {
        toast({ title: "Couldn't leave", description: err.message, variant: "destructive" });
        setLocation("/");
      },
    });
  };

  const handleKick = (targetPlayerId: string, targetName: string) => {
    leaveRoom.mutate(targetPlayerId, {
      onSuccess: () => toast({ title: `${targetName} was removed from the room` }),
      onError: (err) => toast({ title: "Couldn't kick player", description: err.message, variant: "destructive" }),
    });
  };

  return (
    <div className="min-h-screen bg-background relative overflow-hidden flex flex-col items-center justify-center p-4">
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 blur-[100px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-secondary/20 blur-[120px] rounded-full pointer-events-none" />

      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="relative z-10 w-full max-w-md space-y-5"
      >
        {/* Header */}
        <div className="text-center">
          <div className="inline-flex items-center gap-2 bg-green-500/10 border border-green-500/20 text-green-600 text-xs font-bold uppercase tracking-widest px-4 py-1.5 rounded-full mb-4">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            Waiting for players
          </div>
          <img src={assetUrl("card-back.jpg")} alt="Compost Heroes" className="w-24 mx-auto rounded-xl shadow-lg mb-2" draggable={false} />
          <p className="text-muted-foreground text-sm">
            {isHost ? "Share the link below so others can join." : "Waiting for the host to start the game."}
          </p>
        </div>

        {/* Room code + share */}
        <div className="bg-card/80 backdrop-blur-xl rounded-3xl shadow-xl border border-border p-6 space-y-4">
          <div>
            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 block">Room Code</label>
            <div className="flex items-center justify-between bg-muted/40 rounded-2xl px-4 py-3">
              <span className="font-mono text-2xl font-bold tracking-widest text-foreground">{roomCode}</span>
              {hasPassword && (
                <span className="flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-1 font-medium">
                  <Lock className="w-3 h-3" /> Password
                </span>
              )}
            </div>
          </div>

          <div>
            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 block">Invite Link</label>
            <div className="flex gap-2">
              <input
                readOnly
                value={shareUrl}
                onClick={(e) => (e.target as HTMLInputElement).select()}
                className="flex-1 h-11 px-3 rounded-xl border-2 border-border bg-background/50 font-mono text-xs text-muted-foreground focus:outline-none focus:border-primary/50 select-all"
              />
              <button
                onClick={handleCopy}
                className="h-11 w-11 shrink-0 rounded-xl border-2 border-border bg-background/50 flex items-center justify-center hover:bg-muted/50 transition-colors"
              >
                {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4 text-muted-foreground" />}
              </button>
            </div>
          </div>

          {hasPassword && (
            <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-2xl p-3">
              <Lock className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-700">This room is password protected. Share the password alongside this link.</p>
            </div>
          )}
        </div>

        {/* Player + Bot list */}
        <div className="bg-card/80 backdrop-blur-xl rounded-3xl shadow-xl border border-border p-6 space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Users className="w-3.5 h-3.5" /> Players ({totalCount}/{maxPlayers})
            </label>
          </div>

          <div className="space-y-2">
            {/* Human players */}
            {players.map((p, i) => {
              const isMe = i === playerIndex;
              const canKick = isHost && !isMe;
              return (
                <motion.div
                  key={p.id}
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className={`flex items-center gap-3 rounded-2xl px-4 py-3 border-2 ${isMe ? "border-primary/40 bg-primary/5" : "border-border bg-muted/20"}`}
                >
                  <span className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0">
                    {i === 0 ? <Crown className="w-3.5 h-3.5" /> : i + 1}
                  </span>
                  <span className="font-semibold text-sm text-foreground flex-1">{p.name}</span>
                  <div className="flex items-center gap-1.5">
                    {i === 0 && (
                      <span className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 font-bold uppercase tracking-wide">Host</span>
                    )}
                    {isMe && (
                      <span className="text-[10px] text-primary bg-primary/10 border border-primary/20 rounded-full px-2 py-0.5 font-bold uppercase tracking-wide">You</span>
                    )}
                    <span className="w-2 h-2 bg-green-400 rounded-full" />
                    {canKick && (
                      <button
                        onClick={() => handleKick(p.id, p.name)}
                        disabled={leaveRoom.isPending}
                        title={`Remove ${p.name}`}
                        className="w-6 h-6 rounded-lg flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40 ml-1"
                      >
                        <UserX className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </motion.div>
              );
            })}

            {/* Bot slots (host only) */}
            {isHost && botSlots.map((bot, bi) => (
              <motion.div
                key={`bot-${bi}`}
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                className="rounded-2xl border-2 border-dashed border-violet-300/60 bg-violet-50/30 px-4 py-3 space-y-2"
              >
                <div className="flex items-center gap-3">
                  <span className="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center text-violet-500 shrink-0">
                    <Bot className="w-3.5 h-3.5" />
                  </span>
                  <input
                    value={bot.name}
                    onChange={(e) => handleBotName(bi, e.target.value)}
                    className="flex-1 text-sm font-semibold bg-transparent border-b border-violet-200 focus:outline-none focus:border-violet-400 text-foreground placeholder:text-muted-foreground"
                    placeholder="Bot name…"
                  />
                  <button
                    onClick={() => handleRemoveBot(bi)}
                    className="w-6 h-6 rounded-lg flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex items-center gap-1.5 pl-10">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-bold mr-1">Skill:</span>
                  {(["easy", "medium", "hard"] as const).map((lvl) => (
                    <button
                      key={lvl}
                      onClick={() => handleBotSkill(bi, lvl)}
                      className={`text-[10px] font-bold border rounded-full px-2.5 py-0.5 uppercase tracking-wide transition-colors ${
                        bot.skillLevel === lvl
                          ? SKILL_COLORS[lvl]
                          : "text-muted-foreground bg-muted/20 border-border hover:bg-muted/40"
                      }`}
                    >
                      {SKILL_LABELS[lvl]}
                    </button>
                  ))}
                </div>
              </motion.div>
            ))}

            {/* Empty slots */}
            {Array.from({ length: emptySlots }).map((_, i) => (
              <div
                key={`empty-${i}`}
                className="flex items-center gap-3 rounded-2xl px-4 py-3 border-2 border-dashed border-border/50 opacity-50"
              >
                <span className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-muted-foreground text-xs font-bold shrink-0">
                  {totalCount + i + 1}
                </span>
                <span className="text-sm text-muted-foreground italic flex-1">Waiting for player…</span>
                {isHost && i === 0 && (
                  <button
                    onClick={handleAddBot}
                    className="flex items-center gap-1 text-[10px] font-bold text-violet-600 bg-violet-50 border border-violet-200 rounded-full px-2.5 py-1 hover:bg-violet-100 transition-colors"
                  >
                    <Plus className="w-2.5 h-2.5" /> Add Bot
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Add bot button when all slots show bots */}
          {isHost && emptySlots === 0 && botSlots.length > 0 && totalCount < maxPlayers && (
            <button
              onClick={handleAddBot}
              className="w-full flex items-center justify-center gap-1.5 text-xs font-bold text-violet-600 border-2 border-dashed border-violet-300/60 rounded-2xl py-2.5 hover:bg-violet-50/50 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> Add another bot
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="space-y-3">
          {isHost ? (
            <>
              <Button
                size="lg"
                className="w-full h-14 text-xl font-display tracking-wide rounded-xl shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 hover:-translate-y-1 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
                onClick={handleStart}
                disabled={!canStart || startGame.isPending}
              >
                {startGame.isPending ? (
                  <span className="flex items-center gap-2"><Loader2 className="w-5 h-5 animate-spin" /> Starting…</span>
                ) : (
                  `Start Game (${totalCount} player${totalCount !== 1 ? "s" : ""})`
                )}
              </Button>
              {!canStart && (
                <p className="text-center text-xs text-muted-foreground">Need at least 2 players to start.</p>
              )}
            </>
          ) : (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Waiting for the host to start…
            </div>
          )}
          <button
            onClick={handleLeave}
            disabled={leaveRoom.isPending}
            className="w-full flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-destructive transition-colors py-2 disabled:opacity-50"
          >
            {leaveRoom.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <LogOut className="w-3.5 h-3.5" />
            )}
            Leave room
          </button>
        </div>
      </motion.div>
    </div>
  );
}
