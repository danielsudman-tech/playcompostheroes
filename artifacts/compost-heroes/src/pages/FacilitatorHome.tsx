import { useState } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser, useLogout } from "@/components/AppGate";
import { useCreateNewGame, getStoredToken, storeToken } from "@/hooks/use-game";
import { eventId, useCreateEvent, useEvents } from "@/hooks/use-events";
import compostHeroesLogo from "@assets/Compost_Heroes_Logo_no_background_1773537933517.png";
import {
  Users, PlusCircle, Copy, Check, Loader2, LogOut, User, ArrowLeft,
  MonitorPlay, Lock, Tag, HelpCircle, PauseCircle, Trophy, Clock,
  ArrowRight, CalendarDays, LayoutGrid,
} from "lucide-react";

interface FacilitatorRoom {
  gameId: string;
  mode: string;
  label: string | null;
  phase: string;
  playerCount: number;
  maxPlayers: number;
  createdAt: number | null;
  endedAt: number | null;
  winner: string | null;
  paused: boolean;
  openQuestions: number;
}

function getUserToken(): string | null {
  try {
    return localStorage.getItem("compost_user_token");
  } catch {
    return null;
  }
}

function phaseBadge(room: FacilitatorRoom) {
  if (room.phase === "waiting") return { text: "Waiting for players", cls: "bg-amber-100 text-amber-700 border-amber-200" };
  if (room.phase === "game_over") return { text: room.winner ? `Finished — ${room.winner} won` : "Ended", cls: "bg-muted text-muted-foreground border-border" };
  if (room.paused) return { text: "Paused", cls: "bg-blue-100 text-blue-700 border-blue-200" };
  return { text: "In progress", cls: "bg-green-100 text-green-700 border-green-200" };
}

function SessionRow({ room, onOpen }: { room: FacilitatorRoom; onOpen: (id: string) => void }) {
  const [copied, setCopied] = useState(false);
  const badge = phaseBadge(room);
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(room.gameId.toUpperCase());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-3 rounded-2xl border-2 border-border hover:border-primary/40 px-4 py-3 transition-all"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="font-semibold text-sm text-foreground truncate">
            {room.label || `Session ${room.gameId.toUpperCase()}`}
          </span>
          <span className={`text-[10px] font-bold rounded-full border px-1.5 py-0.5 shrink-0 ${badge.cls}`}>{badge.text}</span>
          {room.openQuestions > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] font-bold text-orange-700 bg-orange-100 border border-orange-200 rounded-full px-1.5 py-0.5 shrink-0">
              <HelpCircle className="w-2.5 h-2.5" /> {room.openQuestions} question{room.openQuestions !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
          <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {room.playerCount}/{room.maxPlayers}</span>
          <button
            onClick={copyCode}
            title="Copy session code"
            className="flex items-center gap-1 font-mono font-bold text-foreground/80 bg-muted rounded px-1.5 py-0.5 hover:bg-muted/70 transition-colors"
          >
            {room.gameId.toUpperCase()}
            {copied ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3 opacity-60" />}
          </button>
          {room.createdAt && (
            <span className="flex items-center gap-1 opacity-70">
              <Clock className="w-3 h-3" />
              {new Date(room.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </span>
          )}
        </div>
      </div>
      <Button size="sm" onClick={() => onOpen(room.gameId)} className="shrink-0 rounded-xl font-bold">
        <MonitorPlay className="w-4 h-4 mr-1.5" /> Open
      </Button>
    </motion.div>
  );
}

export default function FacilitatorHome() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const currentUser = useCurrentUser();
  const logout = useLogout();
  const createGame = useCreateNewGame();
  const events = useEvents();
  const createEvent = useCreateEvent();
  const [eventName, setEventName] = useState("");
  const [tableCount, setTableCount] = useState(3);
  const [playersPerTable, setPlayersPerTable] = useState(4);
  const [assignmentMode, setAssignmentMode] = useState<"choose" | "auto">("choose");
  const [idleThresholdMinutes, setIdleThresholdMinutes] = useState(2);
  const [showEventForm, setShowEventForm] = useState(false);

  const [label, setLabel] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [password, setPassword] = useState("");

  const { data: rooms, isLoading } = useQuery<FacilitatorRoom[]>({
    queryKey: ["facilitator-rooms"],
    queryFn: async () => {
      const token = getUserToken();
      const r = await fetch("/api/facilitator/rooms", {
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      if (!r.ok) throw new Error("Failed to load sessions");
      return r.json();
    },
    refetchInterval: 10000,
    enabled: currentUser?.role === "facilitator",
  });

  const handleCreate = () => {
    createGame.mutate(
      {
        hostName: currentUser?.name ?? "Facilitator",
        maxPlayers,
        mode: "facilitated",
        password: password.trim() || undefined,
        label: label.trim() || undefined,
      },
      {
        onSuccess: (data: { gameId: string }) => setLocation(`/game/${data.gameId}/host`),
        onError: (err: Error) => toast({ title: "Failed to create session", description: err.message, variant: "destructive" }),
      }
    );
  };

  // Opening a session from another device: recover the host seat token via
  // the signed-in account before navigating to the dashboard.
  const openSession = async (id: string) => {
    if (!getStoredToken(id)) {
      try {
        const r = await fetch(`/api/games/${id}/host-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userToken: getUserToken() }),
        });
        if (r.ok) {
          const { token } = (await r.json()) as { token: string };
          storeToken(id, token);
        } else {
          const err = await r.json().catch(() => ({}));
          toast({ title: "Couldn't open session", description: (err as any).error ?? "Try again.", variant: "destructive" });
          return;
        }
      } catch {
        toast({ title: "Couldn't open session", description: "Network error — try again.", variant: "destructive" });
        return;
      }
    }
    setLocation(`/game/${id}/host`);
  };

  const activeRooms = (rooms ?? []).filter((r) => r.mode === "facilitated" && r.phase !== "game_over");
  const pastRooms = (rooms ?? []).filter((r) => r.mode === "facilitated" && r.phase === "game_over").slice(0, 5);
  const handleCreateEvent = (e: React.FormEvent) => {
    e.preventDefault();
    createEvent.mutate({ name: eventName.trim(), tableCount, playersPerTable, assignmentMode, idleThresholdMinutes }, {
      onSuccess: (created) => setLocation(`/facilitator/events/${eventId(created)}`),
      onError: (err) => toast({ title: "Couldn't create event", description: err.message, variant: "destructive" }),
    });
  };

  if (currentUser?.role !== "facilitator") {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-xl font-bold">Facilitator approval required</h1>
        <p className="text-sm text-muted-foreground">An administrator must approve your account before you can host sessions.</p>
        <Button onClick={() => setLocation("/")}>Back to lobby</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background relative overflow-hidden flex flex-col items-center p-4 py-8">
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 blur-[100px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-secondary/20 blur-[120px] rounded-full pointer-events-none" />

      <motion.div
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="relative z-10 w-full max-w-2xl space-y-6"
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => setLocation("/")}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors font-medium"
          >
            <ArrowLeft className="w-4 h-4" /> Lobby
          </button>
          {currentUser && (
            <span className="flex items-center gap-3 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <User className="w-3.5 h-3.5" />
                <span className="font-medium text-foreground">{currentUser.name}</span>
              </span>
              <button onClick={logout} className="flex items-center gap-1 text-xs hover:text-destructive transition-colors font-medium">
                <LogOut className="w-3.5 h-3.5" /> Sign out
              </button>
            </span>
          )}
        </div>

        <div className="text-center">
          <img src={compostHeroesLogo} alt="Compost Heroes" className="w-40 mx-auto mb-1 drop-shadow-xl" draggable={false} />
          <p className="event-kicker">Facilitator desk</p>
          <h1 className="text-3xl font-display text-foreground">Make room for everyone.</h1>
          <p className="text-sm text-muted-foreground">One table or a whole gathering — you've got this.</p>
        </div>

        <section className="event-panel p-5 sm:p-7 space-y-5" data-testid="section-facilitator-events">
          <div className="flex flex-wrap justify-between items-start gap-3">
            <div><p className="event-kicker">For groups, camps & gatherings</p><h2 className="font-display text-3xl mt-1">Events</h2><p className="text-sm text-muted-foreground mt-1">Up to ten tables. One shared guest code. A clear view of every game.</p></div>
            <button className="event-button event-button-primary" data-testid="button-new-event" onClick={() => setShowEventForm(!showEventForm)}><PlusCircle size={16} /> {showEventForm ? "Close setup" : "Create Event"}</button>
          </div>
          {showEventForm && <form className="rounded-2xl bg-[#f1f2e8] p-4 sm:p-5 space-y-4" onSubmit={handleCreateEvent} data-testid="form-create-event">
            <div><label htmlFor="event-name" className="event-kicker block mb-1">Name this gathering</label><input id="event-name" className="event-input" required maxLength={80} value={eventName} onChange={e => setEventName(e.target.value)} placeholder="Saturday soil workshop" data-testid="input-event-name" /></div>
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="text-xs font-extrabold space-y-1">Number of tables <select className="event-input" value={tableCount} onChange={e => setTableCount(Number(e.target.value))} data-testid="select-event-table-count">{Array.from({ length: 10 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n} table{n > 1 ? "s" : ""}</option>)}</select></label>
              <label className="text-xs font-extrabold space-y-1">Guests per table <select className="event-input" value={playersPerTable} onChange={e => setPlayersPerTable(Number(e.target.value))} data-testid="select-event-players-per-table">{[2, 3, 4].map(n => <option key={n} value={n}>{n} guests</option>)}</select></label>
            </div>
            <fieldset><legend className="text-xs font-extrabold mb-2">How should guests find a table?</legend><div className="flex gap-2">{(["choose", "auto"] as const).map(mode => <button type="button" key={mode} onClick={() => setAssignmentMode(mode)} data-testid={`button-event-assignment-${mode}`} className={`event-button flex-1 ${assignmentMode === mode ? "event-button-primary" : "event-button-outline"}`}>{mode === "choose" ? "Choose a table" : "Auto-assign"}</button>)}</div></fieldset>
            <label className="text-xs font-extrabold block space-y-1">Flag quiet tables after <select className="event-input" value={idleThresholdMinutes} onChange={e => setIdleThresholdMinutes(Number(e.target.value))} data-testid="select-event-idle-threshold">{[2, 3, 5, 10, 15].map(n => <option key={n} value={n}>{n} minutes</option>)}</select></label>
            <button type="submit" className="event-button event-button-primary w-full" disabled={createEvent.isPending || !eventName.trim()} data-testid="button-create-event">{createEvent.isPending ? "Setting up tables…" : "Create event & open control center"} <ArrowRight size={16} /></button>
          </form>}
          <div className="space-y-4">
            {events.isLoading ? <div className="space-y-2"><div className="event-skeleton h-16" /><div className="event-skeleton h-16" /></div>
              : events.isError ? <div className="text-sm text-destructive p-4 rounded-xl bg-destructive/10">Events couldn't be loaded. <button className="underline font-bold" onClick={() => events.refetch()}>Try again</button></div>
              : (["active", "ending", "upcoming", "completed"] as const).map(status => { const list = (events.data ?? []).filter(e => e.status === status); if (!list.length) return null; return <div key={status}><p className="event-kicker mb-2">{status === "active" ? "In progress" : status === "ending" ? "Ending" : status === "upcoming" ? "Coming up" : "Completed"}</p><div className="space-y-2">{list.map(ev => <button key={eventId(ev)} className="w-full text-left flex items-center gap-3 p-3.5 rounded-xl border border-[#dce2d1] bg-[#fafaf2] hover:border-[#729270] transition-colors" onClick={() => setLocation(`/facilitator/events/${eventId(ev)}`)} data-testid={`button-open-event-${eventId(ev)}`}><div className="w-10 h-10 shrink-0 rounded-xl bg-[#e4ebda] flex items-center justify-center text-[#56775c]"><LayoutGrid size={18} /></div><div className="flex-1 min-w-0"><p className="font-extrabold text-sm truncate">{ev.name}</p><p className="text-xs text-muted-foreground">{ev.tableCount ?? ev.tables?.length ?? 0} tables · {ev.code.toUpperCase()}</p></div><ArrowRight size={16} className="text-[#648069]" /></button>)}</div></div>; })}
            {!events.isLoading && !events.isError && !events.data?.length && <div className="border border-dashed border-[#b9c8b5] rounded-xl px-5 py-6 text-center"><CalendarDays className="mx-auto text-[#779374] mb-2" size={22} /><p className="font-bold text-sm">Your first event starts here.</p><p className="text-xs text-muted-foreground">Set up tables above, then share one code with the whole group.</p></div>}
          </div>
        </section>

        {/* Create session */}
        <div className="bg-card/80 backdrop-blur-xl rounded-3xl shadow-xl border border-border p-6 space-y-4">
          <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <PlusCircle className="w-4 h-4" /> Quick Game · One table
          </h2>
          <div className="relative">
            <Tag className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
            <Input
               placeholder="Session label (e.g. Garden club)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={60}
              className="h-11 pl-9 bg-background/50 border-2 focus-visible:ring-primary/20 text-sm font-medium"
            />
          </div>
          <div className="flex gap-3 flex-wrap items-center">
            <div className="flex gap-2">
              {[2, 3, 4].map((n) => (
                <button
                  key={n}
                  onClick={() => setMaxPlayers(n)}
                  className={`py-2 px-3 rounded-xl border-2 text-sm font-bold transition-all ${maxPlayers === n ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}
                >
                  {n} players
                </button>
              ))}
            </div>
            <div className="relative flex-1 min-w-[160px]">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
              <Input
                type="password"
                placeholder="Password (optional)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-10 pl-9 bg-background/50 border-2 focus-visible:ring-primary/20 text-sm"
              />
            </div>
          </div>
          <Button
            size="lg"
            className="w-full h-12 text-lg font-display tracking-wide rounded-xl shadow-lg shadow-primary/25 hover:shadow-xl hover:-translate-y-0.5 transition-all"
            onClick={handleCreate}
            disabled={createGame.isPending}
          >
            {createGame.isPending ? (
              <span className="flex items-center gap-2"><Loader2 className="w-5 h-5 animate-spin" /> Creating…</span>
            ) : (
              <span className="flex items-center gap-2"><PlusCircle className="w-5 h-5" /> Create Session</span>
            )}
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            You'll get a session code to share — participants enter it on the home page. No accounts needed for them.
          </p>
        </div>

        {/* Active sessions */}
        <div className="bg-card/80 backdrop-blur-xl rounded-3xl shadow-xl border border-border p-6 space-y-3">
          <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <MonitorPlay className="w-4 h-4" /> Your Sessions
          </h2>
          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : activeRooms.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No active sessions. Create one above to get started.</p>
          ) : (
            <div className="space-y-2">
              {activeRooms.map((room) => (
                <SessionRow key={room.gameId} room={room} onOpen={openSession} />
              ))}
            </div>
          )}

          {pastRooms.length > 0 && (
            <>
              <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 pt-2">
                <Trophy className="w-3.5 h-3.5" /> Recent finished sessions
              </h3>
              <div className="space-y-2 opacity-80">
                {pastRooms.map((room) => (
                  <SessionRow key={room.gameId} room={room} onOpen={openSession} />
                ))}
              </div>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}
