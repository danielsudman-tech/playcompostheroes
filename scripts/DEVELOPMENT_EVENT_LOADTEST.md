# Development-only Event reliability scenario

This is a **development reliability scenario**, not a production benchmark. It uses the API over the shared proxy (`http://localhost:80/api` by default), creates a synthetic registered facilitator, approves that account through the existing admin endpoint with `APP_PASSWORD`, and exercises facilitated Event routes. It does not edit persisted game state, tune pool/infrastructure settings, start workflows, or publish an application.

## Safety gates

- Run only while the API workflow is serving the development database.
- The default development run requires `NODE_ENV=development`, `APP_PASSWORD`, `DATABASE_URL`, and the explicit `--confirm-development-database` flag. It refuses normal deployment processes, database names/hosts containing production/live markers, published `*.replit.app` / `*.repl.co` hosts, and API origins outside loopback or `*.replit.dev`.
- The default API URL is `http://localhost:80/api` (shared proxy, not the API service port). `API_BASE_URL` may override it only with a loopback host or allowlisted development preview host.
- The generated account password, account session token, guest seat tokens, host tokens, and SSE ticket stay in process memory. They are never printed or written to fixture/report JSON.
- A separate one-connection `pg` monitor reads aggregate `pg_stat_activity` counts only. It reports connection, active-query, lock-waiter, idle-transaction and longest-active-query maxima. Authenticated `/api/admin/healthz?sinceMs=...` samples separately report API-pool `total`, `idle`, `waiting`, and acquisition-wait `count`, `maxMs` and `p95Ms`; `sinceMs` is a **lookback duration in milliseconds**, computed as `Date.now() - windowStartedAtMs`, not an epoch timestamp. This is the API-pool measurement, unlike the separate PostgreSQL observer.
- Results go to ignored `scripts/results/` files. The fixture manifest contains only the generated facilitator/event/game IDs and synthetic run label. Keep it until cleanup completes.

The explicit database confirmation is an additional guard, not a substitute for checking that `DATABASE_URL` really points to the intended development database. If any safety check fails, stop and ask the owning agent rather than weakening the guard.

### Optional isolated staging VM

An isolated staging VM is opt-in only; this switch does not enable load testing on a published target. It still requires the explicit development-database confirmation and a local shared-proxy API URL, plus `NODE_ENV=development`, `APP_ENV=staging`, `STAGING_VM_LOADTEST=1`, and the VM's `REPLIT_DEPLOYMENT` marker:

```sh
NODE_ENV=development APP_ENV=staging STAGING_VM_LOADTEST=1 \
  API_BASE_URL=http://localhost:80/api \
  pnpm --filter @workspace/scripts run event:reliability -- \
  --scenario A --confirm-development-database --staging-vm
```

The staging switch refuses non-loopback URLs and still checks the database identity. Never point it at a published/prod API or database. No staging VM run or publishing is performed by this harness.

## Complete scenarios

The API workflow must already be running against the intended development database; this utility never starts or restarts workflows. Run the final checks after the backend reliability changes are ready:

```sh
NODE_ENV=development pnpm --filter @workspace/scripts run event:reliability -- --scenario A --confirm-development-database
NODE_ENV=development pnpm --filter @workspace/scripts run event:reliability -- --scenario B --confirm-development-database
```

Scenario A creates four four-seat tables and joins 16 anonymous synthetic guests. Scenario B creates eight four-seat tables and joins 32. The host SSE stream is opened before guest joins. Before readiness the harness reorders a waiting room, transfers one guest, kicks one synthetic guest, and joins a replacement so **all 16/32 seats remain occupied** throughout readiness, steady presence, action rounds and burst checks. The scenario then:

1. Registers the synthetic host through `/auth/register`, approves it through the existing admin route and creates the Event using the documented API.
2. Joins guests in parallel, sends ready and presence bursts, and observes host-dashboard changes over the live SSE feed.
3. Measures a steady presence cadence with independent 12–18 second per-seat jitter. A deliberate dropped guest stops only its heartbeat; the real 45-second disconnect threshold and server sweep must mark it disconnected within 60 seconds, then presence reconnection must restore the dashboard and the same authoritative game state.
4. Drops/reconnects host SSE streams with newly issued single-use tickets, validating that each stream's initial snapshot is authoritative. The host SSE connection remains live before joins, during all scenario phases, and through completion (apart from those explicit reconnections).
5. Starts every table, sends duplicate presence/reconnect bursts, and plays four legal rounds of `draw_card` + `end_turn` so every synthetic guest acts. It checks turn/deck integrity, seat coverage and cross-table isolation, then sends a separate simultaneous cross-table action burst.
6. Exercises parallel pause/resume, unique per-table messages and host announcements. Request-to-dashboard SSE changes for joins, readiness, actions, controls/messages, disconnect/reconnect and completion must be visible within 2 seconds.
7. Ends every game concurrently through the host API and asserts that all table states and the Event reach `completed`.
8. Samples authenticated API-pool diagnostics before/during/after traffic and after each burst. Pure-normal windows remain separately reported, while the overall targets still include all successful normal **and burst** presence requests (p95 `<500 ms`), all legal player actions (p95 `<1 s`), and maximum API-pool acquisition wait across the scenario (`≤1 s`). Burst traffic is not exempt from those overall gates. The normal-window acquisition maximum uses only samples from the separate action-round and disconnect/recovery windows; burst-and-recovery maxima are reported separately, and the run-wide diagnostic is labeled scenario-wide rather than normal. A sustained-exhaustion assertion fires when consecutive samples show `waiting>0` and `idle=0` for at least 2 seconds (samples must be no more than 1.5 seconds apart). Each burst must recover to `waiting=0` and `idle>0` within 10 seconds.

The real presence-loss check requires at least 45 seconds and can need the additional 10-second sweep interval. Every API request and SSE connection establishment has a finite timeout (12 seconds by default); the active host SSE stream itself remains open. The overall deadline is 180 seconds by default and cannot be reduced below 120 seconds:

```sh
NODE_ENV=development pnpm --filter @workspace/scripts run event:reliability -- --scenario B --confirm-development-database --request-timeout-ms 15000 --deadline-seconds 240
```

A timeout/stall, API failure, missed target, or pool-settling failure is reported separately, stops later phases and exits with code 2 after saving the report and fixture manifest. A timed-out client request does not prove server-side work stopped. If the API stalls, keep the report and manifest and let the owning agent coordinate server recovery before cleanup or another run.

The report includes successful/error/timeout request counts, separate normal and burst p50/p95 plus overall successful presence/action p95, per-change request-to-SSE delay, real disconnect detection/recovery time, active seats before/after, action-round coverage, database-monitor snapshots, API-pool normal/burst/scenario-wide windows and checkpoints, sustained-exhaustion incidents, settling latency and assertion outcomes. Overall gates do not discard burst observations. The separate database-safeguards contract test is not a live database timeout measurement and is never presented as one; only actual scenario requests and authenticated pool diagnostics are reported as application measurements.

## Reports and scoped cleanup

Each run prints two paths:

- `scripts/results/event-reliability-<run-id>.report.json`: outcome, operation counts, normal/burst timings, dashboard observations, API-pool diagnostics, database-monitor maxima and synthetic fixture IDs. It contains no credentials or tokens.
- `scripts/results/event-reliability-<run-id>.fixtures.json`: the minimum IDs and exact run marker needed for cleanup, including partially created events.

After the API is responsive (restart it first if a deadlock/stall was observed), pass that exact fixture manifest to cleanup:

```sh
NODE_ENV=development pnpm --filter @workspace/scripts run event:reliability -- --cleanup scripts/results/event-reliability-<run-id>.fixtures.json --confirm-development-database
```

Cleanup paths under `scripts/results/` resolve from the workspace root even when the command is launched with the scripts package as the current directory. An absolute manifest path is also accepted. The resolver checks the real path and rejects symlinks or paths outside the direct `scripts/results/` directory. Before deleting anything, cleanup verifies the synthetic facilitator identity and exact event/run marker, then verifies every extant game against its event/facilitator state and event-table association. It deletes only those verified games through the admin API (which also invalidates game caches and removes game tokens), removes seats/table links scoped to the verified fixture event/game IDs and then the matching Event row, removes analytics rows scoped to the verified fixture facilitator/game IDs, and deletes the synthetic facilitator through the admin API. It then asserts zero fixture events, event tables, seats, games, tokens, analytics, facilitator account, and facilitator sessions remain. It will not search for or delete unrelated games/users. Keep the manifest if cleanup fails; repair/restart the development API and retry with the same file. Never hand-edit its IDs to target real records.

Do not run this script against a published deployment or as a browser/production benchmark. The owning agent should run the final A/B checks and coordinate any API recovery. No load scenario should fake PostgreSQL timeout results or edit game/seat/presence rows.