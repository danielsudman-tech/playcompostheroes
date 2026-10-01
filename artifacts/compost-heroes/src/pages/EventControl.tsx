import { useEffect, useState } from "react";
import { useLocation, useParams } from "wouter";
import { ArrowLeft, Check, Clock3, Copy, ExternalLink, HelpCircle, Link2, Megaphone, Pause, Play, Radio, Send, Settings2, ShieldAlert, Users, WifiOff } from "lucide-react";
import { recoverHostToken } from "@workspace/api-client-react";
import { getStoredToken, storeToken } from "@/hooks/use-game";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/components/AppGate";
import { type EventTable, useEvent, useEventControl, useEventStream, useTableControl, useUpdateEvent, userToken } from "@/hooks/use-events";

type AttentionIssue = { table: EventTable; rank: number; title: string; context: string; elapsed?: string };
function elapsedSince(timestamp: unknown): string | undefined {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return;
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 0) return;
  if (seconds < 60) return "less than a minute ago";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}
function disconnectedDuration(lastSeenAt: number | null | undefined): string {
  if (lastSeenAt == null) return "Never connected";
  // Presence is considered disconnected 45 seconds after the last heartbeat.
  const seconds = Math.max(0, Math.floor((Date.now() - lastSeenAt - 45_000) / 1000));
  if (seconds < 60) return `Disconnected for ${seconds} sec`;
  if (seconds < 3600) return `Disconnected for ${Math.floor(seconds / 60)} min`;
  return `Disconnected for ${Math.floor(seconds / 3600)} hr`;
}
function attentionIssues(table: EventTable, thresholdMinutes: number): AttentionIssue[] {
  const issues: AttentionIssue[] = [];
  const questions = (table.questions ?? []).filter((q): q is Record<string, unknown> => !!q && typeof q === "object" && !Array.isArray(q) && (q as Record<string, unknown>).resolved !== true);
  for (const q of questions) {
    const guest = typeof q.playerName === "string" && q.playerName.trim() ? q.playerName : "A guest";
    issues.push({ table, rank: 0, title: "Help requested", context: `${guest}${typeof q.text === "string" && q.text.trim() ? `: “${q.text}”` : " has a question"}`, elapsed: elapsedSince(q.ts) });
  }
  if (!questions.length && (table.attention?.includes("help") || (table.openQuestions ?? 0) > 0)) {
    issues.push({ table, rank: 0, title: "Help requested", context: `${table.openQuestions ?? 1} open question${(table.openQuestions ?? 1) === 1 ? "" : "s"} at this table` });
  }
  const disconnected = (table.seats ?? table.players ?? []).filter(s => s.connected === false);
  for (const seat of disconnected) issues.push({ table, rank: 1, title: "Guest disconnected", context: `${seat.name ?? seat.playerName ?? "A guest"} is disconnected`, elapsed: disconnectedDuration(seat.lastSeenAt) });
  if (!disconnected.length && (table.attention?.includes("disconnected") || (table.disconnectedCount ?? 0) > 0)) {
    issues.push({ table, rank: 1, title: "Guest disconnected", context: `${table.disconnectedCount ?? 1} guest${(table.disconnectedCount ?? 1) === 1 ? "" : "s"} disconnected` });
  }
  if (table.pendingDecision) issues.push({ table, rank: 2, title: "Decision pending", context: `Waiting on ${table.pendingDecision}` });
  if (table.phase !== "waiting" && table.phase !== "game_over" && !table.paused &&
    (table.attention?.includes("inactive") || (typeof table.lastActivityAt === "number" && Date.now() - table.lastActivityAt >= thresholdMinutes * 60_000))) {
    issues.push({ table, rank: 3, title: "Table inactive", context: "No recent table activity", elapsed: elapsedSince(table.lastActivityAt) });
  }
  return issues;
}
function urgency(table: EventTable, threshold: number) {
  const inactive = table.phase === "waiting" || table.phase === "game_over" || table.paused;
  if (table.attention?.includes("help")) return { rank: 0, label: "Asking for help", tone: "bg-orange-100 text-orange-800" };
  if (table.attention?.includes("disconnected")) return { rank: 1, label: "Player disconnected", tone: "bg-rose-100 text-rose-800" };
  if ((table.openQuestions ?? 0) > 0) return { rank: 0, label: `${table.openQuestions} asking for help`, tone: "bg-orange-100 text-orange-800" };
  if ((table.disconnectedCount ?? (table.seats ?? []).filter(s => s.connected === false).length) > 0) return { rank: 1, label: "Player disconnected", tone: "bg-rose-100 text-rose-800" };
  if (table.pendingDecision) return { rank: 2, label: "Decision pending", tone: "bg-amber-100 text-amber-800" };
  if (!inactive && (table.attention?.includes("inactive") || (table.lastActivityAt != null && (Date.now() - table.lastActivityAt) / 1000 >= threshold * 60))) return { rank: 3, label: "Needs a nudge", tone: "bg-yellow-100 text-yellow-800" };
  return { rank: 4, label: table.phase === "game_over" ? "Finished" : table.paused ? "Paused" : table.phase === "waiting" ? "Gathering players" : "On track", tone: "bg-emerald-100 text-emerald-800" };
}
function feedback(result: { results?: { gameId: string; success: boolean; error: string | null }[]; gameId?: string; success?: boolean; error?: string | null }, action: string, labels?: Map<string, string>) {
  const failures = result.results?.filter(r => !r.success) ?? (result.success === false && result.gameId ? [{ gameId: result.gameId, error: result.error ?? "Unknown error" }] : []);
  if (failures.length) return { title: `${action}: ${failures.length} table${failures.length === 1 ? "" : "s"} need attention`, description: failures.map(f => `${labels?.get(f.gameId) ?? f.gameId}: ${f.error || (action === "Start ready tables" ? "Couldn't start; check that guests are ready." : "Couldn't update this table.")}`).join("; "), variant: "destructive" as const };
  return { title: action === "Start ready tables" ? "Ready tables started" : `${action} sent`, description: "The tables have been updated." };
}
export default function EventControl() {
  const { eventId: id = "" } = useParams<{ eventId: string }>();
  const [, navigate] = useLocation();
  const user = useCurrentUser();
  const { toast } = useToast();
  const { data: event, isLoading, isError, refetch } = useEvent(id);
  const live = useEventStream(id);
  const control = useEventControl(id);
  const tableControl = useTableControl(id);
  const update = useUpdateEvent(id);
  const [message, setMessage] = useState("");
  const [target, setTarget] = useState<EventTable | null>(null);
  const [tableMessage, setTableMessage] = useState("");
  const [confirm, setConfirm] = useState<"start" | "pause" | "resume" | "end" | null>(null);
  const [settings, setSettings] = useState(false);
  const [name, setName] = useState("");
  const [threshold, setThreshold] = useState(2);
  const [triviaEnabled, setTriviaEnabled] = useState(true);
  const [copied, setCopied] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  useEffect(() => { if (event) { setName(event.name); setThreshold(event.idleThresholdMinutes ?? 2); setTriviaEnabled(event.triviaEnabled !== false); } }, [event?.name, event?.idleThresholdMinutes, event?.triviaEnabled]);
  useEffect(() => {
    if (event?.status === "ending" || event?.status === "completed") {
      setConfirm(null);
      setTarget(null);
      setSettings(false);
    }
  }, [event?.status]);
  const shareLink = event ? `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}/event/${event.code}` : "";
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1800); toast({ title: "Copied to clipboard" }); }
    catch { toast({ title: "Couldn't copy", description: "Select the code or link instead.", variant: "destructive" }); }
  };
  const sendControl = (action: "start" | "message" | "pause" | "resume" | "end", text?: string) => {
    if (!event || event.status === "completed" || (event.status === "ending" && action !== "end")) return;
    control.mutate({ action, text }, { onSuccess: (result) => { toast(feedback(result, action === "message" ? "Message" : action === "end" ? "End event" : action === "pause" ? "Pause" : action === "start" ? "Start ready tables" : "Resume", new Map(event?.tables.map(t => [t.gameId, t.label ?? t.name ?? `Table ${t.tableNumber}`]) ?? []))); setConfirm(null); if (action === "message") setMessage(""); }, onError: (err) => toast({ title: "Couldn't update event", description: err.message, variant: "destructive" }) });
  };
  const sendTable = (table: EventTable, action: "message" | "pause" | "resume", text?: string) => {
    if (!event || event.status === "ending" || event.status === "completed" || table.phase === "game_over") return;
    tableControl.mutate({ gameId: table.gameId, action, text }, { onSuccess: (result) => { toast(feedback(result, `Table ${table.tableNumber ?? table.gameId}`)); setTarget(null); setTableMessage(""); }, onError: err => toast({ title: "Table wasn't updated", description: err.message, variant: "destructive" }) });
  };
  const openTable = async (table: EventTable) => {
    setOpening(table.gameId);
    try {
      if (!getStoredToken(table.gameId)) {
        const result = await recoverHostToken(table.gameId, { userToken: userToken() });
        storeToken(table.gameId, result.token);
      }
      navigate(`/game/${table.gameId}/host`);
    } catch (err) { toast({ title: "Couldn't open table", description: (err as Error).message, variant: "destructive" }); }
    finally { setOpening(null); }
  };
  if (user?.role !== "facilitator") return <main className="event-shell grid place-items-center p-6"><div className="event-panel p-8 max-w-md text-center"><h1 className="text-2xl font-display">Host access needed</h1><p className="text-sm text-muted-foreground mt-2">Sign in with the approved facilitator account for this event.</p><button className="event-button event-button-soft mt-5" onClick={() => navigate("/facilitator")}>Back to facilitator</button></div></main>;
  if (isLoading) return <main className="event-shell p-6"><div className="max-w-7xl mx-auto space-y-6"><div className="event-skeleton h-20 w-2/3" /><div className="event-skeleton h-40 w-full" /><div className="grid md:grid-cols-3 gap-4">{[1, 2, 3].map(n => <div className="event-skeleton h-52" key={n} />)}</div></div></main>;
  if (isError || !event) return <main className="event-shell grid place-items-center p-6"><div className="event-panel p-8 text-center"><ShieldAlert className="mx-auto text-destructive" /><h1 className="text-2xl font-display mt-3">We couldn't open this event</h1><button className="event-button event-button-primary mt-5" onClick={() => refetch()}>Try again</button></div></main>;
  const tables = [...(event.tables ?? [])].sort((a, b) => urgency(a, threshold).rank - urgency(b, threshold).rank || (a.tableNumber ?? 0) - (b.tableNumber ?? 0));
  const issues = tables.flatMap(table => attentionIssues(table, threshold)).sort((a, b) => a.rank - b.rank || (a.table.tableNumber ?? 0) - (b.table.tableNumber ?? 0));
  const guests = tables.reduce((sum, t) => sum + (t.playerCount ?? t.seats?.length ?? t.players?.length ?? 0), 0);
  const eventClosing = event.status === "ending" || event.status === "completed";
  return <main className="event-shell">
    <div className="max-w-[1480px] mx-auto px-4 sm:px-7 py-6 lg:py-8 space-y-6">
      <header className="flex flex-wrap items-center gap-3">
        <button className="event-button event-button-outline" data-testid="button-back-events" onClick={() => navigate("/facilitator")}><ArrowLeft size={16} /> Events</button>
        <span className="event-kicker ml-auto flex items-center gap-2"><span className={`w-2 h-2 rounded-full ${live ? "bg-emerald-500" : "bg-amber-400"}`} /> {live ? "Live updates" : "Checking every 10s"}</span>
      </header>
      <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 border-b border-[#d5ddcb] pb-7">
        <div><p className="event-kicker mb-2">Compost Heroes / Event control</p><h1 className="font-display text-4xl sm:text-5xl leading-tight">{event.name}</h1><p className="text-[#71826a] mt-1 font-bold">{event.status === "completed" ? "Event completed" : event.status === "ending" ? "Ending — tables are closing" : event.status === "upcoming" ? "Waiting for your guests" : "Your tables, all in one place."}</p></div>
        <div className="flex flex-wrap gap-2">
          <button className="event-button event-button-outline" disabled={eventClosing} data-testid="button-edit-event" onClick={() => setSettings(!settings)}><Settings2 size={15} /> Settings</button>
          <button className="event-button event-button-primary" data-testid="button-copy-event-link" onClick={() => copy(shareLink)}>{copied ? <Check size={16} /> : <Link2 size={16} />} Copy guest link</button>
        </div>
      </section>
      {settings && <form className="event-panel p-5 flex flex-wrap gap-3 items-end" onSubmit={e => { e.preventDefault(); update.mutate({ name: name.trim(), idleThresholdMinutes: threshold, triviaEnabled }, { onSuccess: () => { setSettings(false); toast({ title: "Event settings saved" }); }, onError: err => toast({ title: "Couldn't save settings", description: err.message, variant: "destructive" }) }); }}>
        <label className="flex-1 min-w-[200px] text-xs font-extrabold space-y-1">Event name<input className="event-input" value={name} maxLength={80} required onChange={e => setName(e.target.value)} data-testid="input-edit-event-name" /></label>
        <label className="w-44 text-xs font-extrabold space-y-1">Idle alert (minutes)<input className="event-input" type="number" min={2} max={60} value={threshold} onChange={e => setThreshold(Number(e.target.value))} data-testid="input-edit-idle-threshold" /></label>
        <label className="flex items-center gap-2 text-xs font-extrabold"><input type="checkbox" checked={triviaEnabled} onChange={e => setTriviaEnabled(e.target.checked)} data-testid="checkbox-event-trivia-enabled" /> Enable optional compost trivia for guests</label>
        <button className="event-button event-button-primary" disabled={update.isPending || !name.trim()} data-testid="button-save-event">Save changes</button>
        <button type="button" className="event-button event-button-outline" onClick={() => setSettings(false)}>Cancel</button>
      </form>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="event-panel p-4"><p className="event-kicker">Tables</p><p className="font-display text-3xl mt-1">{tables.length}</p></div>
        <div className="event-panel p-4"><p className="event-kicker">Guests seated</p><p className="font-display text-3xl mt-1">{guests}</p></div>
        <div className="event-panel p-4"><p className="event-kicker">Need attention</p><p className={`font-display text-3xl mt-1 ${issues.length ? "text-[#a65937]" : ""}`}>{issues.length}</p></div>
        <button className="event-panel p-4 text-left hover:border-[#6e9871] transition-colors" onClick={() => copy(event.code.toUpperCase())} data-testid="button-copy-event-code"><p className="event-kicker">Guest code <Copy size={11} className="inline" /></p><p className="font-mono text-xl font-black tracking-widest mt-2 select-all" data-testid="text-event-code">{event.code.toUpperCase()}</p></button>
      </div>
      <section className="event-panel p-4 sm:p-5 flex flex-col xl:flex-row gap-4 xl:items-center">
        <div className="xl:w-48 shrink-0"><p className="event-kicker">Across every table</p><h2 className="font-display text-xl">Host controls</h2></div>
        <form className="flex flex-1 gap-2 min-w-0" onSubmit={e => { e.preventDefault(); if (message.trim()) sendControl("message", message.trim()); }}>
          <input className="event-input flex-1" aria-label="Message to all tables" placeholder={event.status === "ending" ? "Event is ending" : event.status === "completed" ? "This event has ended" : "A note to every table…"} maxLength={300} value={message} disabled={eventClosing} onChange={e => setMessage(e.target.value)} data-testid="input-event-message" />
          <button className="event-button event-button-primary" type="submit" disabled={!message.trim() || control.isPending || eventClosing} data-testid="button-send-event-message"><Send size={15} /> <span className="hidden sm:inline">Send</span></button>
        </form>
        <div className="flex flex-wrap gap-2">
          <button className="event-button event-button-soft" disabled={control.isPending || eventClosing} onClick={() => setConfirm("pause")} data-testid="button-pause-event"><Pause size={15} /> Pause all</button>
          <button className="event-button event-button-soft" disabled={control.isPending || eventClosing} onClick={() => setConfirm("resume")} data-testid="button-resume-event"><Play size={15} /> Resume all</button>
          <button className="event-button event-button-soft" disabled={control.isPending || eventClosing} onClick={() => setConfirm("start")} data-testid="button-start-event"><Play size={15} /> Start ready tables</button>
          <button className="event-button event-button-warn" disabled={control.isPending || event.status === "completed"} onClick={() => setConfirm("end")} data-testid="button-end-event">{event.status === "ending" ? "Retry end event" : "End event"}</button>
        </div>
      </section>
      <section className="event-panel overflow-hidden" aria-label="Prioritized attention list" data-testid="event-attention-list">
        <div className="px-5 py-4 bg-[#e9ecdd] flex items-center justify-between gap-3 border-b border-[#d5ddcb]">
          <div><p className="event-kicker">Your next move</p><h2 className="font-display text-2xl flex items-center gap-2"><Radio size={19} className="text-[#aa6440]" /> Prioritized attention</h2></div>
          <span className="text-xs font-extrabold text-[#617361]">{issues.length} {issues.length === 1 ? "issue" : "issues"}</span>
        </div>
        {issues.length ? <div className="divide-y divide-[#e4e8d9]">
          {issues.map((issue, index) => <div key={`${issue.table.gameId}-${issue.rank}-${index}`} className="flex flex-col sm:flex-row sm:items-center gap-3 px-5 py-3.5" data-testid={`attention-issue-${index}`}>
            <span className={`shrink-0 w-2 h-2 rounded-full ${issue.rank === 0 ? "bg-[#c46d3e]" : issue.rank === 1 ? "bg-[#bb6772]" : issue.rank === 2 ? "bg-[#bf9853]" : "bg-[#a1a658]"}`} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap gap-x-2 items-baseline"><strong className="text-sm text-[#293f31]">Table {issue.table.tableNumber ?? "—"}{issue.table.label || issue.table.name ? ` · ${issue.table.label ?? issue.table.name}` : ""}</strong><span className="text-xs font-extrabold text-[#aa6440]">{issue.title}</span></div>
              <p className="text-sm text-[#617361] break-words">{issue.context}{issue.elapsed ? <span className="text-[#879481]"> · {issue.elapsed}</span> : null}</p>
            </div>
            <button className="event-button event-button-outline shrink-0 self-start sm:self-auto" disabled={opening === issue.table.gameId} onClick={() => openTable(issue.table)} data-testid={`button-attention-view-${index}`}>View table <ExternalLink size={14} /></button>
          </div>)}
        </div> : <div className="px-5 py-6 flex items-center gap-3 text-[#4e7656]"><Check size={20} /><p className="text-sm font-bold">All clear. No tables need your attention right now.</p></div>}
      </section>
      <section className="grid md:grid-cols-2 xl:grid-cols-3 gap-4 pb-12" aria-label="Event tables">
        {tables.map((table, index) => {
          const alert = urgency(table, threshold);
          const seats = table.seats ?? table.players ?? [];
          const count = table.playerCount ?? seats.length;
          const max = table.maxPlayers ?? event.playersPerTable ?? event.maxPlayersPerTable ?? 4;
          const readyCount = table.readyCount ?? seats.filter(s => s.ready).length;
          const readyToStart = table.phase === "waiting" && count >= 2 && seats.length === count && seats.every(s => s.ready === true && s.connected === true);
          return <article key={table.gameId} className={`event-panel p-5 flex flex-col gap-4 ${alert.rank === 0 ? "!border-[#db9f72]" : alert.rank < 4 ? "!border-[#e5c49b]" : ""}`} data-testid={`card-event-table-${table.gameId}`}>
            <div className="flex justify-between items-start gap-3"><div><p className="event-kicker">Table {table.tableNumber ?? index + 1}</p><h3 className="font-display text-2xl leading-tight">{table.label ?? table.name ?? `Table ${table.tableNumber ?? index + 1}`}</h3></div><span className={`rounded-full px-2.5 py-1 text-[11px] font-extrabold whitespace-nowrap ${readyToStart ? "bg-[#d6ecd4] text-[#2e7349]" : alert.tone}`} data-testid={`status-table-${table.gameId}`}>{readyToStart ? "Ready to start" : alert.label}</span></div>
            <div className="flex flex-wrap items-center gap-3 text-xs font-bold text-[#637365]"><span className="flex gap-1 items-center"><Users size={14} /> {count}/{max} seated</span><span className="flex gap-1 items-center"><Check size={14} /> {readyCount} ready</span><span className="flex gap-1 items-center"><Clock3 size={14} /> {table.phase === "waiting" ? "Waiting" : `${table.progress ?? 0}/5 layers`}</span></div>
            <div className="min-h-16 rounded-xl bg-[#f2f2e8] p-3 text-sm"><p className="font-bold">{table.winner ? `${table.winner} won` : table.pendingDecision ? `Waiting on a decision: ${table.pendingDecision}` : table.currentPlayerName ? `${table.currentPlayerName}'s turn` : table.phase === "waiting" ? "Waiting to begin" : table.phase === "game_over" ? "Game finished" : "Game in progress"}</p><p className="text-xs text-[#71826a] mt-1">{table.openQuestions ? `${table.openQuestions} open question${table.openQuestions > 1 ? "s" : ""}` : table.paused ? "Table paused" : table.phase === "waiting" ? "Guests can join with the event code" : "No open questions"}</p></div>
            {seats.length > 0 && <div className="flex flex-wrap gap-1.5">{seats.map((seat, i) => <span key={seat.playerId ?? i} title={`${seat.name ?? seat.playerName ?? "Guest"}: ${seat.ready ? "ready" : "not ready"}, ${seat.connected === false ? "disconnected" : "present"}`} className={`text-xs font-bold rounded-full px-2.5 py-1 ${seat.connected === false ? "bg-rose-100 text-rose-700" : seat.ready ? "bg-emerald-100 text-emerald-800" : "bg-[#ebeadc] text-[#6e7868]"}`}>{seat.connected === false && <WifiOff size={11} className="inline mr-1" />}{seat.name ?? seat.playerName ?? `Guest ${i + 1}`}</span>)}</div>}
            <div className="flex flex-wrap gap-2 mt-auto pt-1 border-t border-[#e5e8da]">
              <button className="event-button event-button-primary flex-1" onClick={() => openTable(table)} disabled={opening === table.gameId} data-testid={`button-view-table-${table.gameId}`}><ExternalLink size={14} /> View table</button>
              <button className="event-button event-button-outline" disabled={eventClosing || table.phase === "game_over"} onClick={() => { setTarget(table); setTableMessage(""); }} data-testid={`button-message-table-${table.gameId}`} aria-label={`Message table ${table.tableNumber ?? index + 1}`}><Megaphone size={15} /></button>
              <button className="event-button event-button-outline" disabled={eventClosing || table.phase === "game_over" || tableControl.isPending} onClick={() => sendTable(table, table.paused ? "resume" : "pause")} data-testid={`button-pause-table-${table.gameId}`}>{table.paused ? <Play size={15} /> : <Pause size={15} />}</button>
            </div>
          </article>;
        })}
      </section>
      {tables.length === 0 && <div className="event-panel text-center p-10"><HelpCircle className="mx-auto text-primary mb-3" /><p className="font-display text-xl">Tables are being prepared</p><button className="event-button event-button-soft mt-4" onClick={() => refetch()}>Check again</button></div>}
    </div>
    {(confirm || target) && <div className="fixed inset-0 z-50 bg-[#26392d]/50 flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget) { setConfirm(null); setTarget(null); } }}>
      <div className="event-panel w-full max-w-md p-6 shadow-2xl" role="dialog" aria-modal="true" aria-label={confirm ? `Confirm ${confirm}` : "Message table"}>
        {confirm ? <><p className="event-kicker">Confirm action</p><h2 className="font-display text-3xl mt-2">{confirm === "end" ? event.status === "ending" ? "Retry ending this event?" : "End this event?" : confirm === "start" ? "Start ready tables?" : `${confirm === "pause" ? "Pause" : "Resume"} every table?`}</h2><p className="text-sm text-[#71826a] mt-2">{confirm === "end" ? event.status === "ending" ? "Some tables may still be closing. Retry the end action to finish them." : "This ends play for every table. This cannot be undone." : confirm === "start" ? "Tables without enough ready guests may not start. Any failed tables will be listed so you can help them." : "Each table will be updated. If one fails, you can retry it from its card."}</p><div className="flex justify-end gap-2 mt-6"><button className="event-button event-button-outline" onClick={() => setConfirm(null)}>{event.status === "ending" ? "Cancel" : "Keep playing"}</button><button className={`event-button ${confirm === "end" ? "event-button-warn" : "event-button-primary"}`} disabled={control.isPending || event.status === "completed" || (event.status === "ending" && confirm !== "end")} onClick={() => sendControl(confirm)} data-testid="button-confirm-event-control">{confirm === "start" ? "Start ready tables" : confirm === "end" && event.status === "ending" ? "Retry end event" : `Yes, ${confirm} all`}</button></div></>
          : target && <form onSubmit={e => { e.preventDefault(); if (tableMessage.trim() && !eventClosing && target.phase !== "game_over") sendTable(target, "message", tableMessage.trim()); }}><p className="event-kicker">Only this table</p><h2 className="font-display text-3xl mt-2">Message {target.label ?? target.name ?? `Table ${target.tableNumber ?? ""}`}</h2><textarea className="event-input mt-5 py-3 min-h-28" maxLength={300} autoFocus disabled={eventClosing} value={tableMessage} onChange={e => setTableMessage(e.target.value)} placeholder="Write a note for this table…" data-testid="input-table-message" /><div className="flex justify-end gap-2 mt-4"><button type="button" className="event-button event-button-outline" onClick={() => setTarget(null)}>Cancel</button><button className="event-button event-button-primary" disabled={!tableMessage.trim() || tableControl.isPending || eventClosing || target.phase === "game_over"} data-testid="button-send-table-message"><Send size={15} /> Send note</button></div></form>}
      </div>
    </div>}
  </main>;
}