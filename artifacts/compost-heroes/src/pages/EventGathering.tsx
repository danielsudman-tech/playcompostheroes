import { ArrowLeft, ArrowRight, CircleAlert, Clock3, Leaf, Megaphone, Users } from "lucide-react";
import { Link, useParams } from "wouter";
import compostHeroesLogo from "@assets/Compost_Heroes_Logo_no_background_1773537933517.png";
import { PostGameLinks } from "@/components/PostGameLinks";
import { PILE_CATEGORIES, getEffectiveFn } from "@/components/facilitated/PlayerBoardRow";
import { rememberedEventSeat, useEventPresence, useGuestEvent } from "@/hooks/use-events";
import { getStoredToken, useGameState } from "@/hooks/use-game";

function tableStage(phase?: string) {
  if (phase === "game_over") return "Finished";
  if (!phase || phase === "waiting" || phase === "setup") return "Waiting";
  return "Playing";
}

export default function EventGathering() {
  const { code: routeCode = "" } = useParams<{ code: string }>();
  const code = routeCode.toLowerCase();
  const lobbyPath = `/event/${encodeURIComponent(code)}`;
  const seat = rememberedEventSeat(code);
  const token = seat?.gameId ? getStoredToken(seat.gameId) ?? seat.token : null;
  const { data: event, isLoading: eventLoading, isError: eventError, error: eventLoadError, refetch: refetchEvent } = useGuestEvent(code);
  // Only the saved guest's table is queried. The public event response supplies
  // the other tables' statuses without exposing their game states or host detail.
  const { data: game, isLoading: gameLoading, isError: gameError, refetch: refetchGame } = useGameState(
    seat?.gameId && token ? seat.gameId : null,
    token,
  );
  useEventPresence(code, seat, !!seat && event?.status !== "completed");

  if (eventLoading) {
    return <main className="event-shell px-4 py-8 sm:py-12">
      <div className="max-w-5xl mx-auto space-y-6" aria-label="Loading gathering" role="status">
        <div className="event-skeleton h-5 w-36" />
        <div className="event-skeleton h-14 w-64 max-w-full" />
        <div className="grid md:grid-cols-[1.15fr_.85fr] gap-5">
          <div className="event-skeleton h-80" />
          <div className="event-skeleton h-80" />
        </div>
      </div>
    </main>;
  }

  if (eventError || !event) {
    return <main className="event-shell px-4 grid place-items-center">
      <div className="event-panel w-full max-w-md p-7 sm:p-9 text-center">
        <CircleAlert size={30} className="mx-auto text-[#a65937]" />
        <h1 className="font-display text-3xl mt-3">{(eventLoadError as { status?: number } | null)?.status === 404 ? "This event has been removed" : "We lost the gathering."}</h1>
        <p className="text-sm text-[#637365] mt-2">{(eventLoadError as { status?: number } | null)?.status === 404 ? "The event and its results are no longer available." : "Check your connection or return to your invitation."}</p>
        <div className="flex flex-wrap justify-center gap-2 mt-6">
          <button type="button" data-testid="button-retry-event-results" className="event-button event-button-primary" onClick={() => void refetchEvent()}>Try again</button>
          <Link href={lobbyPath} data-testid="link-results-event-lobby-error" className="event-button event-button-outline">Event lobby</Link>
        </div>
      </div>
    </main>;
  }

  const ownPlayer = game?.players.find(p => p.id === seat?.playerId)
    ?? (!seat?.playerId && seat?.playerName ? game?.players.find(p => p.name === seat.playerName) : undefined);
  const winner = game?.phase === "game_over" && !game.endedByHost && game.winner
    ? game.players.find(p => p.id === game.winner) : undefined;
  const collected = ownPlayer
    ? PILE_CATEGORIES.filter(category => ownPlayer.compostPile.some(card => card != null && category.match(getEffectiveFn(card))))
    : [];
  const finished = game?.phase === "game_over";
  const tablesFinished = event.tables.filter(table => tableStage(table.phase) === "Finished").length;
  const statusMessage = event.status === "completed"
    ? "The event has wrapped up. Thanks for sharing a table today."
    : event.status === "ending"
      ? "Your host is wrapping up the event. Stay on Zoom for a final word together."
      : event.status === "active"
        ? finished
          ? "Your table is done; others may still be playing. Stay on Zoom and rejoin the group when your host calls everyone back."
          : "Tables are at their own pace. Your host will bring everyone back together."
        : "The tables are getting ready. Your host will let everyone know when it's time to begin.";

  return <main className="event-shell min-h-[100dvh] px-4 py-7 sm:py-11">
    <div className="max-w-5xl mx-auto">
      <header className="flex items-center justify-between gap-4 mb-9 sm:mb-12">
        <Link href={lobbyPath} data-testid="link-results-event-lobby" className="event-button event-button-outline"><ArrowLeft size={16} /> Event lobby</Link>
        <img src={compostHeroesLogo} alt="Compost Heroes" className="w-28 sm:w-36 h-auto" />
      </header>

      <div className="mb-7 sm:mb-9">
        <p className="event-kicker">The gathering / {event.code.toUpperCase()}</p>
        <div className="flex flex-wrap items-end justify-between gap-3 mt-2">
          <div>
            <h1 className="font-display text-4xl sm:text-5xl leading-tight" data-testid="text-event-results-title">Around the tables.</h1>
            <p className="text-[#637365] text-sm sm:text-base mt-1" data-testid="text-event-results-name">{event.name}</p>
          </div>
          <span data-testid="status-event-results" className="inline-flex items-center gap-2 rounded-full bg-[#e4ebdc] text-[#3d7046] px-3.5 py-2 text-xs font-extrabold">
            <span className="size-2 rounded-full bg-[#5c9a66]" aria-hidden="true" />
            {event.status === "completed" ? "Event complete" : event.status === "ending" ? "Wrapping up" : event.status === "active" ? "Gathering in progress" : "Getting ready"}
          </span>
        </div>
      </div>

      <div className="grid md:grid-cols-[minmax(0,1.15fr)_minmax(0,.85fr)] gap-5 items-start">
        <div className="space-y-5 min-w-0">
          <section className="event-panel overflow-hidden" aria-labelledby="own-table-heading">
            <div className="bg-[#dfeadb] px-5 sm:px-7 py-5 sm:py-6">
              <p className="event-kicker">Your table {seat?.tableNumber ? `/ 0${seat.tableNumber}` : ""}</p>
              <h2 id="own-table-heading" className="font-display text-3xl sm:text-4xl mt-1">
                {!seat ? "Your seat isn't saved here." : gameLoading ? "Checking your table…" : finished ? winner ? `${winner.name} made compost!` : "A round well played." : "Your place at the table."}
              </h2>
              {seat && <p className="text-sm text-[#56705b] mt-2">You're here as {seat.playerName ?? "a guest"}.</p>}
            </div>
            <div className="px-5 sm:px-7 py-5 sm:py-6">
              {!seat || !token ? (
                <div>
                  <p className="text-sm leading-relaxed text-[#637365]">This browser doesn't have a saved seat for this event. Return to the invitation to find your place.</p>
                  <Link href={lobbyPath} data-testid="link-results-find-seat" className="event-button event-button-primary mt-5">Go to event lobby <ArrowRight size={16} /></Link>
                </div>
              ) : gameLoading ? (
                <div aria-label="Loading your table" role="status" className="space-y-3">
                  <div className="event-skeleton h-5 w-2/3" /><div className="event-skeleton h-14 w-full" /><div className="event-skeleton h-14 w-full" />
                </div>
              ) : gameError || !game ? (
                <div>
                  <CircleAlert size={21} className="text-[#a65937]" />
                  <p className="text-sm text-[#637365] mt-2">We couldn't load your table's result. Your seat is still saved on this browser.</p>
                  <button type="button" data-testid="button-retry-own-result" className="event-button event-button-outline mt-4" onClick={() => void refetchGame()}>Try again</button>
                </div>
              ) : (
                <>
                  <p className="text-sm text-[#4b654e] leading-relaxed" data-testid="text-own-table-result">
                    {finished
                      ? winner
                        ? winner.id === ownPlayer?.id ? "You collected all 5 compost functions!" : `${winner.name} collected all 5 compost functions.`
                        : game.endedByHost ? "Your host closed the round. The group will come back together shortly." : "The round is complete. Thanks for playing your part."
                      : "Your table is still in play. Head back whenever you're ready."}
                  </p>
                  {ownPlayer ? <div className="mt-6">
                    <div className="flex justify-between items-baseline gap-3 mb-3">
                      <h3 className="font-display text-xl">Your compost functions</h3>
                      <span className="font-display text-xl text-[#426c4a]" data-testid="text-own-components-count">{collected.length}<span className="text-sm text-[#71826a]"> / 5</span></span>
                    </div>
                    <p className="text-xs text-[#71826a] mb-4">Collect a Hero for each of the 5 functions.</p>
                    <ul className="grid grid-cols-2 sm:grid-cols-3 gap-2" aria-label="Your compost functions">
                      {PILE_CATEGORIES.map(category => {
                        const has = collected.some(item => item.key === category.key);
                        return <li key={category.key} data-testid={`status-own-component-${category.key}`} className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-extrabold ${has ? "bg-[#e8efdf] border-[#b7cba9] text-[#385b42]" : "bg-[#faf8ef] border-[#e4e5d9] text-[#8c9886]"}`}>
                          <span aria-hidden="true" className={`size-2.5 rounded-full shrink-0 ${has ? "bg-[#598a59]" : "border border-[#aebba6]"}`} />
                          {category.label}
                        </li>;
                      })}
                    </ul>
                  </div> : <p className="mt-4 text-xs text-[#71826a]">Your individual compost mix isn't available from this saved seat.</p>}
                  {!finished && <Link href={`/game/${encodeURIComponent(seat.gameId)}/table`} data-testid="link-results-back-to-table" className="event-button event-button-primary mt-6">Return to your table <ArrowRight size={16} /></Link>}
                </>
              )}
            </div>
          </section>
          {game?.hostMessage?.text && <aside className="event-panel p-5 sm:px-7 flex gap-3" data-testid="text-event-host-message">
            <Megaphone className="text-[#426c4a] shrink-0 mt-0.5" size={19} />
            <div><p className="event-kicker">A note from your host</p><p className="text-sm text-[#304235] mt-1 whitespace-pre-wrap">{game.hostMessage.text}</p></div>
          </aside>}
        </div>

        <div className="space-y-5 min-w-0">
          <section className="event-panel p-5 sm:p-7" aria-labelledby="wrap-up-heading">
            <div className="flex items-start gap-3">
              <span className="size-10 rounded-xl bg-[#e9edde] text-[#426c4a] flex items-center justify-center shrink-0"><Clock3 size={20} /></span>
              <div>
                <p className="event-kicker">The room / {event.status}</p>
                <h2 id="wrap-up-heading" className="font-display text-2xl mt-1">{event.status === "completed" ? "Thanks for being here." : event.status === "ending" ? "Coming back together." : "Stay a little longer."}</h2>
              </div>
            </div>
            <p className="text-sm leading-relaxed text-[#637365] mt-5" data-testid="text-event-wrap-up">{statusMessage}</p>
          </section>

          <section className="event-panel p-5 sm:p-7" aria-labelledby="table-status-heading">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2"><Users size={17} className="text-[#608563]" /><h2 id="table-status-heading" className="font-display text-2xl">All tables</h2></div>
              <span className="text-xs font-extrabold text-[#71826a]" data-testid="text-finished-tables">{tablesFinished} / {event.tables.length} finished</span>
            </div>
            <p className="text-xs text-[#71826a] mt-2 mb-3">A shared view, without interrupting anyone's game.</p>
            {event.tables.length ? <ul className="divide-y divide-[#e6e8dd]">
              {event.tables.map((table, index) => {
                const number = table.tableNumber ?? index + 1;
                const stage = tableStage(table.phase);
                const yours = number === seat?.tableNumber;
                return <li key={number} data-testid={`status-event-table-${number}`} className="flex items-center gap-3 py-3">
                  <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${stage === "Finished" ? "bg-[#5c9a66]" : stage === "Playing" ? "bg-[#ca9959]" : "bg-[#c1c9b9]"}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-extrabold text-[#304235]">Table {number} {yours && <span className="text-[#668266] font-semibold">· yours</span>}</p>
                    <p className="text-xs text-[#71826a]">{table.occupied ?? 0} / {table.capacity ?? 4} seated</p>
                  </div>
                  <span className={`text-xs font-extrabold ${stage === "Finished" ? "text-[#3d7046]" : stage === "Playing" ? "text-[#976830]" : "text-[#71826a]"}`}>{stage}</span>
                </li>;
              })}
            </ul> : <div className="rounded-xl bg-[#f3f3e9] p-4 flex gap-2 text-sm text-[#637365]"><Leaf size={17} className="shrink-0" /> Tables will appear here when the host sets them up.</div>}
          </section>
        </div>
      </div>
      {(finished || event.status === "completed") && <PostGameLinks className="mt-5" />}
      <p className="text-center text-xs text-[#71826a] mt-8">Made to be played together. Take your time getting back to the group.</p>
    </div>
  </main>;
}