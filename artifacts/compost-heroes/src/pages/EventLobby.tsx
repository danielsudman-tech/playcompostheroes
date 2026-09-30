import { useEffect, useState } from "react";
import { useLocation, useParams } from "wouter";
import { ArrowLeft, ArrowRight, Check, CircleAlert, Users } from "lucide-react";
import compostHeroesLogo from "@assets/Compost_Heroes_Logo_no_background_1773537933517.png";
import { useToast } from "@/hooks/use-toast";
import { joinEvent } from "@workspace/api-client-react";
import { type EventJoin, rememberedEventSeat, rememberEventSeat, useEventPresence, useGuestEvent, useJoinEvent, useReadyEvent } from "@/hooks/use-events";

export default function EventLobby() {
  const { code: rawCode = "" } = useParams<{ code: string }>();
  const code = rawCode.toLowerCase();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { data: event, isLoading, isError, refetch } = useGuestEvent(code);
  const join = useJoinEvent(code);
  const ready = useReadyEvent(code);
  const [name, setName] = useState("");
  const [tableNumber, setTableNumber] = useState<number | undefined>();
  const [seat, setSeat] = useState<EventJoin | null>(() => rememberedEventSeat(code));
  const [locallyReady, setLocallyReady] = useState(() => {
    const saved = rememberedEventSeat(code);
    try { return !!saved && localStorage.getItem(`compost_event_ready_${saved.gameId}`) === "yes"; } catch { return false; }
  });
  useEffect(() => {
    const saved = rememberedEventSeat(code);
    setSeat(saved);
    try { setLocallyReady(!!saved && localStorage.getItem(`compost_event_ready_${saved.gameId}`) === "yes"); } catch { setLocallyReady(false); }
    if (!saved) return;
    let cancelled = false;
    joinEvent(code, { name: saved.playerName ?? "Guest", existingToken: saved.token })
      .then(result => { if (!cancelled) { rememberEventSeat(code, result); setSeat(result); } })
      .catch(() => { if (!cancelled) toast({ title: "Couldn't reconnect your seat", description: "Check your connection and try refreshing.", variant: "destructive" }); });
    return () => { cancelled = true; };
  }, [code]);
  useEventPresence(code, seat, !!seat);
  const table = event?.tables.find(t => t.tableNumber === seat?.tableNumber);
  const ownSeat = (table?.seats ?? table?.players ?? []).find(s => s.playerId === seat?.playerId || (!!seat?.playerName && (s.name ?? s.playerName) === seat.playerName));
  const isReady = locallyReady || ownSeat?.ready === true;
  const max = event?.playersPerTable ?? event?.maxPlayersPerTable ?? 4;
  const enter = () => { if (seat) navigate(`/game/${seat.gameId}/table`); };
  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || event?.status === "ending" || event?.status === "completed") return;
    join.mutate({ name: name.trim(), ...(event?.assignmentMode === "auto" ? {} : tableNumber !== undefined ? { tableNumber } : {}) }, {
      onSuccess: result => { setSeat(result); toast({ title: "You're in", description: "Let your host know when you're ready." }); },
      onError: err => toast({ title: "Couldn't join this event", description: err.message, variant: "destructive" }),
    });
  };
  if (isLoading) return <main className="event-shell grid place-items-center px-4"><div className="event-panel p-8 w-full max-w-lg space-y-4"><div className="event-skeleton h-10 w-2/3" /><div className="event-skeleton h-5 w-full" /><div className="event-skeleton h-36 w-full" /></div></main>;
  if (isError || !event) return <main className="event-shell grid place-items-center px-4"><div className="event-panel p-8 w-full max-w-md text-center"><CircleAlert className="mx-auto text-[#a65937]" size={32} /><h1 className="font-display text-3xl mt-3">That event isn't here</h1><p className="text-sm text-[#71826a] mt-2">Check the code with your host, or try again.</p><div className="flex justify-center gap-2 mt-5"><button className="event-button event-button-outline" onClick={() => navigate("/")}>Home</button><button className="event-button event-button-primary" onClick={() => refetch()}>Try again</button></div></div></main>;
  return <main className="event-shell min-h-[100dvh] px-4 py-8 sm:py-12">
    <div className="max-w-5xl mx-auto">
      <button className="event-button event-button-outline mb-8" data-testid="button-event-back-home" onClick={() => navigate("/")}><ArrowLeft size={15} /> Home</button>
      <div className="grid lg:grid-cols-[.85fr_1.15fr] gap-7 lg:gap-12 items-start">
        <div className="lg:sticky lg:top-12 pt-2">
          <img src={compostHeroesLogo} alt="Compost Heroes" className="w-44 mb-6" />
          <p className="event-kicker">Your invitation / {code.toUpperCase()}</p>
          <h1 className="font-display text-5xl sm:text-6xl leading-[1.03] mt-3" data-testid="text-guest-event-name">{event.name}</h1>
          <p className="text-[#637365] mt-5 max-w-sm leading-relaxed">Pull up a chair. Your host is looking after the tables; all you need is your name and a little curiosity.</p>
          <div className="mt-8 inline-flex items-center gap-2 rounded-full bg-[#e4ebdc] text-[#3d7046] px-4 py-2 text-xs font-extrabold"><span className="w-2 h-2 bg-[#5c9a66] rounded-full" /> {event.status === "completed" ? "Event finished" : event.status === "ending" ? "Event is ending" : `${event.tables.length} tables in this event`}</div>
        </div>
        <div className="space-y-4">
          {seat ? <div className="event-panel overflow-hidden">
            <div className="bg-[#dfeadb] px-6 py-5"><p className="event-kicker">Your seat is saved</p><h2 className="font-display text-3xl mt-1">Welcome, {seat.playerName ?? "player"}.</h2><p className="text-sm text-[#56705b] mt-1">Your seat is at table {table?.tableNumber ?? seat.tableNumber ?? ""}.</p></div>
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between rounded-xl border border-[#d9ddca] p-4"><div><p className="font-extrabold text-sm">{table?.label ?? table?.name ?? `Table ${table?.tableNumber ?? seat.tableNumber ?? ""}`}</p><p className="text-xs text-[#71826a] mt-1">{table?.playerCount ?? table?.seats?.length ?? 0}/{table?.maxPlayers ?? max} seated</p></div><span className={`text-xs font-extrabold px-3 py-1.5 rounded-full ${isReady ? "bg-[#e2efde] text-[#397445]" : "bg-[#f3ebd9] text-[#916a32]"}`}>{isReady ? "Ready" : "Not ready yet"}</span></div>
              <p className="text-sm text-[#637365]">{event.status === "completed" ? "This event has ended." : event.status === "ending" ? "Your host is ending the event. New joins and readiness are closed." : "Say you're ready, then head to the table. Your host will start play when your group is settled."}</p>
              {event.status !== "completed" && event.status !== "ending" && <div className="flex flex-col sm:flex-row gap-2">
                <button className="event-button event-button-soft flex-1" disabled={isReady || ready.isPending} data-testid="button-event-ready" onClick={() => { if (event.status !== "ending" && event.status !== "completed") ready.mutate(seat, { onSuccess: () => { try { localStorage.setItem(`compost_event_ready_${seat.gameId}`, "yes"); } catch {} setLocallyReady(true); toast({ title: "Your host knows you're ready" }); }, onError: err => toast({ title: "Couldn't mark you ready", description: err.message, variant: "destructive" }) }); }}><Check size={16} /> {isReady ? "You're ready" : "I'm ready"}</button>
                <button className="event-button event-button-primary flex-1" onClick={enter} data-testid="button-enter-event-table">Enter table <ArrowRight size={16} /></button>
              </div>}
            </div>
          </div> : <form onSubmit={handleJoin} className="event-panel p-6 sm:p-8 space-y-5">
            <div><p className="event-kicker">Step 01 / Join the group</p><h2 className="font-display text-3xl mt-2">Find your seat.</h2><p className="text-sm text-[#71826a] mt-1">No account needed. Your seat stays with this browser.</p></div>
            <label className="block text-sm font-extrabold space-y-2">What should we call you?<input autoFocus className="event-input" placeholder="Your name" maxLength={30} required value={name} onChange={e => setName(e.target.value)} data-testid="input-event-guest-name" /></label>
            {event.assignmentMode !== "auto" && <div><p className="text-sm font-extrabold mb-2">Choose a table <span className="font-normal text-[#71826a]">(or let us find one)</span></p><div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <button type="button" onClick={() => setTableNumber(undefined)} className={`p-3 rounded-xl text-left border-2 transition-colors ${tableNumber === undefined ? "bg-[#e5eedf] border-[#618e65]" : "bg-[#faf8ef] border-[#d9ddca]"}`} data-testid="button-table-auto"><span className="block text-sm font-black">Find me a seat</span><span className="text-xs text-[#71826a]">Best available</span></button>
              {event.tables.map((t, i) => { const num = t.tableNumber ?? i + 1; const count = t.playerCount ?? t.seats?.length ?? t.players?.length ?? 0; const full = count >= (t.maxPlayers ?? max); return <button key={t.gameId} type="button" disabled={full || t.phase === "game_over"} onClick={() => setTableNumber(num)} className={`p-3 rounded-xl text-left border-2 transition-colors disabled:opacity-40 ${tableNumber === num ? "bg-[#e5eedf] border-[#618e65]" : "bg-[#faf8ef] border-[#d9ddca]"}`} data-testid={`button-choose-table-${num}`}><span className="block text-sm font-black">{t.label ?? `Table ${num}`}</span><span className="text-xs text-[#71826a]">{full ? "Full" : `${count}/${t.maxPlayers ?? max} seats`}</span></button>; })}
            </div></div>}
            {(event.status === "ending" || event.status === "completed") && <p className="text-sm font-bold text-[#a65937]">{event.status === "ending" ? "The host is ending this event. New seats are closed." : "This event has ended. New seats are closed."}</p>}
            <button className="event-button event-button-primary w-full !min-h-12" type="submit" disabled={!name.trim() || join.isPending || event.status === "ending" || event.status === "completed"} data-testid="button-join-event">{join.isPending ? "Finding your place…" : "Take a seat"} <ArrowRight size={16} /></button>
          </form>}
          <div className="event-panel p-5"><div className="flex items-center gap-2 mb-3"><Users size={16} className="text-[#608563]" /><h3 className="font-display text-xl">Around the tables</h3></div><div className="space-y-2">{event.tables.map((t, i) => <div key={t.gameId} className="flex items-center justify-between gap-2 text-sm border-t border-[#e6e8dd] pt-2"><span className="font-bold">{t.label ?? `Table ${t.tableNumber ?? i + 1}`}</span><span className="text-xs text-[#71826a]">{t.playerCount ?? t.occupied ?? 0}/{t.maxPlayers ?? t.capacity ?? max} seated{t.readyCount !== undefined ? ` · ${t.readyCount} ready` : ""}</span></div>)}</div></div>
        </div>
      </div>
    </div>
  </main>;
}