# Development-only Event reliability burst test

This harness is a **development baseline probe**, not a production load test. It uses the API over the shared proxy (`http://localhost:80/api` by default), creates a synthetic registered facilitator, approves that account through the existing admin endpoint with `APP_PASSWORD`, and exercises facilitated Event routes. It does not edit persisted game state directly or change pool/infrastructure settings.

## Safety gates

- Run only while the API workflow is serving the development database.
- The harness requires `NODE_ENV=development`, `APP_PASSWORD`, `DATABASE_URL`, and the explicit `--confirm-development-database` flag. It refuses deployment processes, database names/hosts containing production/live markers, published `*.replit.app` / `*.repl.co` hosts, and API origins outside loopback or `*.replit.dev`.
- The default API URL is `http://localhost:80/api` (shared proxy, not the API service port). `API_BASE_URL` may override it only with a loopback host or allowlisted development preview host.
- The generated account password, account session token, guest seat tokens, host tokens, and SSE ticket stay in process memory. They are never printed or written to fixture/report JSON.
- A separate one-connection `pg` monitor reads aggregate `pg_stat_activity` counts only. It reports connection, active-query, lock-waiter, idle-transaction and longest-active-query maxima. The observer connection is not part of the API pool.
- Results go to ignored `scripts/results/` files. The fixture manifest contains only the generated facilitator/event/game IDs and synthetic run label. Keep it until cleanup completes.

The explicit database confirmation is an additional guard, not a substitute for checking that `DATABASE_URL` really points to a development database. If any safety check fails, stop and ask the owning agent rather than weakening the guard.

## Baseline scenarios

Run before changing reliability source code so the report reflects the original behavior. The API workflow must already be running; this utility never starts or restarts workflows.

```sh
NODE_ENV=development pnpm --filter @workspace/scripts run event:reliability -- --scenario A --confirm-development-database
```

Scenario A creates four four-seat tables and joins 16 anonymous synthetic guests. Scenario B creates eight four-seat tables and joins 32. Before readiness, it kicks one synthetic guest and transfers another into the newly open seat, preserving at least two guests at every table for Start All. The harness then:

1. Registers the synthetic host through `/auth/register`, grants facilitator access using `PATCH /admin/users/:id/facilitator` and the `x-admin-key` header.
2. Creates one Event through `/facilitator/events`; guests join through its public code concurrently.
3. Reorders synthetic waiting seats, transfers a guest between tables, and kicks a synthetic guest before starting.
4. Bursts all remaining ready and presence requests together. This deliberately stresses nested game locks while each mutation does further database work; a lock/pool exhaustion stall is captured rather than waited on forever.
5. Opens and closes a facilitator SSE stream after validating its initial event, then overlaps Start All, host Event detail reads and two presence bursts per remaining guest (a reconnect/visibility-unlock burst).
6. Sends valid concurrent `draw_card` and `end_turn` player actions on each table, records presence/player-action p50 and p95, exercises pause/resume/message controls, reads host detail again, reconnects a fresh one-use host SSE ticket, and ends the Event.

Every API/SSE request has a finite timeout (12 seconds by default) and each run has a finite overall deadline (180 seconds). Override only for a deliberate rerun:

```sh
NODE_ENV=development pnpm --filter @workspace/scripts run event:reliability -- --scenario B --confirm-development-database --request-timeout-ms 15000 --deadline-seconds 240
```

A timeout/stall or API failure stops later phases and exits with code 2 after saving the report and fixture manifest. In particular, a baseline that exhausts the API pool may leave server-side requests/locks behind; do **not** treat a timed-out client request as proof that server work stopped. Record the report and let the owning agent coordinate an API workflow restart before cleanup or another run.

The p95 targets from the audit are <500 ms for presence and <1 s for normal player actions. The separate database monitor reports PostgreSQL-wide connection/activity/lock-wait snapshots; without API-side pool instrumentation it cannot directly observe the application pool's internal checkout queue. Request latency, timeout counts, server connection counts and lock waits are reported instead. This harness intentionally makes no backend instrumentation change before the baseline.

## Reports and scoped cleanup

Each run prints two paths:

- `scripts/results/event-reliability-<run-id>.report.json`: outcome, operation counts, timings, database-monitor maxima and synthetic fixture IDs. It contains no credentials or tokens.
- `scripts/results/event-reliability-<run-id>.fixtures.json`: the minimum IDs and exact run marker needed for cleanup, including partially created events.

After the API is responsive (restart it first if a deadlock/stall was observed), pass that exact fixture manifest to cleanup:

```sh
NODE_ENV=development pnpm --filter @workspace/scripts run event:reliability -- --cleanup scripts/results/event-reliability-<run-id>.fixtures.json --confirm-development-database
```

Cleanup requires a manifest directly under `scripts/results/`. It discovers only events with the manifest facilitator ID and exact `DEV-LOADTEST <run-id> scenario-X` name, checks the recorded event/game IDs against those rows, deletes those games with the admin API, deletes only the matching synthetic Event row (the API has no Event-delete route), then deletes the synthetic facilitator through the admin API. It will not search for or delete unrelated games/users. Keep the manifest if cleanup fails; repair/restart the development API and retry with the same file. Never hand-edit its IDs to target real records.

Do not run this script against a published deployment or as a browser/production benchmark. The owning agent should capture this unchanged-source baseline first, then compare a later run only after coordinating reliability source changes.