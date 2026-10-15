import type { GameEngagementMetrics, GameEngagementReport } from "@workspace/api-client-react";

const MODE_LABELS: Record<string, string> = {
  standalone: "Pass & Play",
  online: "Online",
  facilitated: "Facilitated",
  facilitator: "Legacy local",
};

function modeLabel(mode: string) {
  return MODE_LABELS[mode] ?? mode;
}

function pct(num: number, den: number): string {
  if (den <= 0) return "unavailable";
  return `${((num / den) * 100).toFixed(1)}%`;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "unavailable";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function seats(v: number | null) {
  return v == null ? "unavailable" : String(v);
}

function Metric({ label, value, sub, testId }: { label: string; value: string | number; sub?: string; testId: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div data-testid={testId} className={value === "unavailable" ? "text-sm italic text-muted-foreground" : "text-xl font-bold text-foreground tabular-nums"}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function GameEngagementPanel({ report }: { report: GameEngagementReport | undefined }) {
  if (!report) {
    return (
      <div className="bg-card border border-border rounded-xl p-4 text-xs text-muted-foreground italic" data-testid="text-engagement-unavailable">
        Game lifecycle data is unavailable from this server.
      </div>
    );
  }
  const t: GameEngagementMetrics = report.totals;

  return (
    <div className="space-y-3" data-testid="panel-game-engagement">
      <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Game Lifecycle &amp; Engagement</h2>

      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Metric testId="text-eng-created" label="Created" value={t.createdGames} sub="distinct game IDs" />
          <Metric testId="text-eng-started" label="Started" value={t.startedGames} sub="unlaunched rooms excluded" />
          <Metric testId="text-eng-completed" label="Completed" value={t.completedGames} sub={`${t.hostEndedGames} ended by host`} />
          <Metric testId="text-eng-legacy" label="Legacy games" value={t.legacyGames} sub="engagement/timing unknown" />
        </div>
        <div className="border-t border-border pt-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Metric
            testId="text-eng-first-turn"
            label="Finished first turn"
            value={pct(t.firstTurnGames, t.trackedHumanStarts)}
            sub={`${t.firstTurnGames} of ${t.trackedHumanStarts} tracked human starts`}
          />
          <Metric
            testId="text-eng-completion-rate"
            label="Completion rate"
            value={pct(t.trackedCompletions, t.timedStarts)}
            sub={`${t.trackedCompletions} of ${t.timedStarts} timed starts`}
          />
          <Metric
            testId="text-eng-duration"
            label="Avg. elapsed (won)"
            value={formatDuration(t.averageDurationSeconds)}
            sub={`${t.durationSamples} sample${t.durationSamples === 1 ? "" : "s"}`}
          />
          <Metric
            testId="text-eng-seats"
            label="Seats human / bot"
            value={t.humanSeats == null && t.botSeats == null ? "unavailable" : `${seats(t.humanSeats)} / ${seats(t.botSeats)}`}
            sub="configured slots, not people"
          />
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 pt-4 pb-2 border-b border-border text-sm font-bold text-foreground">By Mode</div>
        {report.byMode.length === 0 ? (
          <div className="px-4 py-6 text-xs text-muted-foreground italic text-center">No games recorded yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="px-4 py-2 font-medium">Mode</th>
                  <th className="px-2 py-2 font-medium text-right">Created</th>
                  <th className="px-2 py-2 font-medium text-right">Started</th>
                  <th className="px-2 py-2 font-medium text-right">First turn</th>
                  <th className="px-2 py-2 font-medium text-right">Completed</th>
                  <th className="px-2 py-2 font-medium text-right">Host ended</th>
                  <th className="px-2 py-2 font-medium text-right">Completion rate</th>
                  <th className="px-2 py-2 font-medium text-right">Avg. elapsed</th>
                  <th className="px-2 py-2 font-medium text-right">Seats H / B</th>
                  <th className="px-4 py-2 font-medium text-right">Legacy</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.byMode.map(m => (
                  <tr key={m.mode} data-testid={`row-engagement-${m.mode}`} className="tabular-nums">
                    <td className="px-4 py-2 font-medium text-foreground whitespace-nowrap">{modeLabel(m.mode)}</td>
                    <td className="px-2 py-2 text-right">{m.createdGames}</td>
                    <td className="px-2 py-2 text-right">{m.startedGames}</td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">
                      {pct(m.firstTurnGames, m.trackedHumanStarts)}
                      <span className="text-muted-foreground"> ({m.firstTurnGames}/{m.trackedHumanStarts})</span>
                    </td>
                    <td className="px-2 py-2 text-right">{m.completedGames}</td>
                    <td className="px-2 py-2 text-right">{m.hostEndedGames}</td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">
                      {pct(m.trackedCompletions, m.timedStarts)}
                      <span className="text-muted-foreground"> ({m.trackedCompletions}/{m.timedStarts})</span>
                    </td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">
                      <span className={m.averageDurationSeconds == null ? "italic text-muted-foreground" : ""}>{formatDuration(m.averageDurationSeconds)}</span>
                      <span className="text-muted-foreground"> (n={m.durationSamples})</span>
                    </td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">{seats(m.humanSeats)} / {seats(m.botSeats)}</td>
                    <td className="px-4 py-2 text-right">{m.legacyGames}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="px-4 py-3 border-t border-border text-[11px] text-muted-foreground space-y-1" data-testid="text-engagement-note">
          <p>
            First turn counts games where a real human finished their own turn (bot and timer actions excluded); its rate uses tracked human starts.
            Completion rate uses tracked completions over timed starts only. Average elapsed is wall-clock time for won games with a known start and end, not active-play time.
            Seats are configured slots on shared devices, not unique people.
          </p>
          <p>
            Historical coverage: {t.legacyGames} legacy game{t.legacyGames === 1 ? "" : "s"} keep their start/completion counts, but their engagement and timing are unknown and excluded from rates.
            {report.timingNote ? ` ${report.timingNote}` : ""}
          </p>
        </div>
      </div>
    </div>
  );
}
