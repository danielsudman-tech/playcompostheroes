import type { GameRoundSummary } from "@workspace/api-client-react";

export function RoundHistory({ rounds }: { rounds?: GameRoundSummary[] }) {
  if (!rounds?.length) return null;
  return <details className="rounded-xl border border-border bg-card p-3 text-left text-sm" data-testid="round-history">
    <summary className="cursor-pointer font-bold">Previous rounds ({rounds.length})</summary>
    <div className="mt-3 space-y-3 max-h-64 overflow-y-auto">
      {[...rounds].reverse().map(round => <article key={round.roundNumber} className="border-t border-border pt-2">
        <p className="font-bold">Round {round.roundNumber}: {round.winnerName ? `${round.winnerName} won` : "Ended by host"}</p>
        <p className="text-xs text-muted-foreground mb-1">{round.turns} turns</p>
        {round.standings.map(player => <p key={player.playerId} className="text-xs text-muted-foreground">
          {player.name}: {player.functionsFilled}/5 functions
        </p>)}
      </article>)}
    </div>
  </details>;
}
