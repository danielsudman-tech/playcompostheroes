import type { GameState } from "./gameEngine.js";
import type { PgQueryable } from "./gameStore.js";

/** Mark genuine human turn completion, not unattended timer/bot progress. */
export function markFirstHumanTurn(before: GameState, after: GameState, actorId: string, now = Date.now()): void {
  const actor = before.players[before.currentPlayerIndex];
  if (after.analyticsFirstTurnCompletedAt || !actor || actor.id !== actorId || actor.isBot ||
      before.phase === "waiting" || before.phase === "game_over") return;
  if (after.turnNumber > before.turnNumber ||
      (after.turnSequence ?? 0) > (before.turnSequence ?? 0) ||
      (after.phase === "game_over" && !!after.winner && !after.endedByHost)) {
    after.analyticsFirstTurnCompletedAt = now;
  }
}

/**
 * One statement atomically saves gameplay and one per-game lifecycle record.
 * Retrying cannot duplicate counts, and a ledger failure rolls back the game write.
 * Held clients are reused, including callers already inside a transaction.
 */
export const STORE_GAME_WITH_ANALYTICS_SQL = `
WITH previous_game AS MATERIALIZED (
  SELECT state, created_at FROM compost_games WHERE game_id=$1
), written_game AS (
  INSERT INTO compost_games (game_id, state, updated_at)
  VALUES ($1, $2, NOW())
  ON CONFLICT (game_id) DO UPDATE SET state=EXCLUDED.state, updated_at=NOW()
  RETURNING game_id, state, created_at
), lifecycle AS (
  SELECT g.*, p.state AS previous_state,
    (g.state->>'phase' IN ('draw','play') OR
      (g.state->>'phase'='game_over' AND
        (NULLIF(g.state->>'winner','') IS NOT NULL OR p.state->>'phase' IN ('draw','play')))) AS has_started,
    (p.state IS NULL OR p.state->>'phase'='waiting') AS start_time_known
  FROM written_game g LEFT JOIN previous_game p ON TRUE
)
INSERT INTO compost_game_analytics AS a
  (game_id,mode,created_at,started,started_at,first_turn_at,ended_at,end_reason,player_count,human_count,bot_count,legacy,is_test)
SELECT game_id, state->>'mode', created_at, COALESCE(has_started,FALSE),
  CASE WHEN has_started AND start_time_known THEN
    CASE WHEN previous_state IS NULL THEN
      COALESCE(to_timestamp((state->>'createdAt')::double precision/1000),NOW())
    ELSE NOW() END END,
  to_timestamp((state->>'analyticsFirstTurnCompletedAt')::double precision/1000),
  CASE WHEN state->>'phase'='game_over' THEN
    COALESCE(to_timestamp((state->>'endedAt')::double precision/1000),NOW()) END,
  CASE WHEN state->>'phase'='game_over' THEN
    CASE WHEN state->>'endedByHost'='true' THEN 'host_ended'
      WHEN NULLIF(state->>'winner','') IS NOT NULL THEN 'won' ELSE 'ended_without_winner' END END,
  CASE WHEN has_started AND start_time_known THEN jsonb_array_length(state->'players') END,
  CASE WHEN has_started AND start_time_known THEN
    (SELECT COUNT(*) FROM jsonb_array_elements(state->'players') p WHERE COALESCE(p->>'isBot','false')!='true') END,
  CASE WHEN has_started AND start_time_known THEN
    (SELECT COUNT(*) FROM jsonb_array_elements(state->'players') p WHERE p->>'isBot'='true') END,
  NOT start_time_known,$3::boolean
FROM lifecycle
ON CONFLICT (game_id) DO UPDATE SET
  started=a.started OR EXCLUDED.started,
  started_at=COALESCE(a.started_at,EXCLUDED.started_at),
  first_turn_at=COALESCE(a.first_turn_at,EXCLUDED.first_turn_at),
  ended_at=COALESCE(a.ended_at,EXCLUDED.ended_at),
  end_reason=COALESCE(a.end_reason,EXCLUDED.end_reason),
  player_count=CASE WHEN NOT a.started THEN EXCLUDED.player_count ELSE a.player_count END,
  human_count=CASE WHEN NOT a.started THEN EXCLUDED.human_count ELSE a.human_count END,
  bot_count=CASE WHEN NOT a.started THEN EXCLUDED.bot_count ELSE a.bot_count END
WHERE (NOT a.started AND EXCLUDED.started)
  OR (a.started_at IS NULL AND EXCLUDED.started_at IS NOT NULL)
  OR (a.first_turn_at IS NULL AND EXCLUDED.first_turn_at IS NOT NULL)
  OR (a.ended_at IS NULL AND EXCLUDED.ended_at IS NOT NULL)`;

/** Legacy records remain intact; dedupe by game ID and do not invent old timing. */
export const GAME_METRICS_CTE = `
WITH legacy_created AS (
  SELECT DISTINCT ON (game_id) game_id,created_at,metadata::jsonb->>'mode' AS mode,int_value,
    (metadata::jsonb->>'bots')::integer AS bots
  FROM compost_analytics_events WHERE event_type='game_created' AND game_id IS NOT NULL
    AND metadata::jsonb->>'isTest' IS DISTINCT FROM 'true'
  ORDER BY game_id,created_at
), legacy_completed AS (
  SELECT game_id,MIN(created_at) AS ended_at FROM compost_analytics_events
  WHERE event_type='game_completed' AND game_id IS NOT NULL
    AND metadata::jsonb->>'isTest' IS DISTINCT FROM 'true' GROUP BY game_id
), game_metrics AS (
  SELECT game_id,mode,created_at,started,started_at,first_turn_at,ended_at,end_reason,player_count,human_count,bot_count,legacy
  FROM compost_game_analytics WHERE NOT is_test
  UNION ALL
  SELECT c.game_id,COALESCE(c.mode,'unknown'),c.created_at,
    (c.mode IN ('standalone','facilitator') OR f.game_id IS NOT NULL),NULL::timestamptz,
    NULL::timestamptz,f.ended_at,CASE WHEN f.game_id IS NOT NULL THEN 'won' END,
    c.int_value,CASE WHEN c.int_value IS NOT NULL AND c.bots IS NOT NULL THEN c.int_value-c.bots END,c.bots,TRUE
  FROM legacy_created c LEFT JOIN legacy_completed f ON f.game_id=c.game_id
  WHERE NOT EXISTS (SELECT 1 FROM compost_game_analytics a WHERE a.game_id=c.game_id)
)`;

export async function readGameEngagement(client: PgQueryable) {
  const result = await client.query(`${GAME_METRICS_CTE}
    SELECT CASE WHEN GROUPING(mode)=1 THEN 'all' ELSE mode END AS mode,
      COUNT(*)::integer AS "createdGames",
      COUNT(*) FILTER (WHERE started)::integer AS "startedGames",
      COUNT(*) FILTER (WHERE started_at IS NOT NULL)::integer AS "timedStarts",
      COUNT(*) FILTER (WHERE started_at IS NOT NULL AND human_count>0)::integer AS "trackedHumanStarts",
      COUNT(*) FILTER (WHERE first_turn_at IS NOT NULL AND started_at IS NOT NULL)::integer AS "firstTurnGames",
      COUNT(*) FILTER (WHERE end_reason='won')::integer AS "completedGames",
      COUNT(*) FILTER (WHERE end_reason='host_ended')::integer AS "hostEndedGames",
      COUNT(*) FILTER (WHERE started_at IS NOT NULL AND end_reason='won')::integer AS "trackedCompletions",
      COUNT(*) FILTER (WHERE started_at IS NOT NULL AND ended_at>=started_at AND end_reason='won')::integer AS "durationSamples",
      ROUND(AVG(EXTRACT(EPOCH FROM ended_at-started_at))
        FILTER (WHERE started_at IS NOT NULL AND ended_at>=started_at AND end_reason='won'))::integer AS "averageDurationSeconds",
      SUM(human_count)::integer AS "humanSeats",SUM(bot_count)::integer AS "botSeats",
      COUNT(*) FILTER (WHERE legacy)::integer AS "legacyGames"
    FROM game_metrics GROUP BY GROUPING SETS ((),(mode)) ORDER BY mode`);
  return {
    totals: result.rows.find(row => row.mode === "all"),
    byMode: result.rows.filter(row => row.mode !== "all"),
    timingNote: "First-turn engagement and elapsed duration are available only for games tracked from their start. Historical timing is not inferred. Seats are not unique people.",
  };
}
