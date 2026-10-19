import type { GameState } from "@workspace/api-client-react";

export interface ReplaySeat {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  isBot?: boolean;
  botCovering?: boolean;
}

export function replaySeats(state: GameState): ReplaySeat[] {
  return state.players.map(player => ({
    id: player.id,
    name: player.name,
    ready: (state.replayReadyPlayerIds ?? []).includes(player.id),
    connected: (state.connectedPlayerIds ?? []).includes(player.id),
    isBot: player.isBot,
    botCovering: player.botCovering,
  }));
}

export function ReplayReadiness({ seats }: { seats: ReplaySeat[] }) {
  const humans = seats.filter(seat => !seat.isBot || seat.botCovering);
  return <section className="w-full rounded-xl border bg-muted/40 p-3 text-left text-sm space-y-2" aria-label="Ready for another round" data-testid="replay-readiness">
    <p className="font-semibold">{humans.filter(seat => seat.ready).length} of {humans.length} players ready</p>
    <ul className="space-y-1" aria-live="polite">
      {seats.map(seat => <li key={seat.id} className="flex justify-between gap-3">
        <span className="break-words min-w-0">{seat.name}</span>
        <span className="text-muted-foreground text-right">
          {seat.isBot && !seat.botCovering ? "Bot" : [
            seat.ready ? "Ready" : "Not ready",
            !seat.connected ? "Disconnected" : null,
            seat.botCovering ? "Bot covering" : null,
          ].filter(Boolean).join(" · ")}
        </span>
      </li>)}
    </ul>
    <p className="text-xs text-muted-foreground">Optional check-in. Only the host can start a round, even if not everyone is ready.</p>
  </section>;
}
