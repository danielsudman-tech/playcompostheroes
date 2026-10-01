# Event reliability baseline

Development workspace and development database only. No published deployment or production database was used.

## Unchanged-code reproduction

The baseline ran before changes to presence, game locks, persistence, or database timeouts, against application revision `15d79a4`.

```sh
NODE_ENV=development pnpm --filter @workspace/scripts run event:reliability -- --scenario A --confirm-development-database --deadline-seconds 60 --request-timeout-ms 8000
```

- Scenario A: four tables, sixteen simultaneous anonymous join requests.
- All sixteen join requests hit their eight-second client deadline; none returned seat credentials.
- The database observer saw ten connections, with no active PostgreSQL query or PostgreSQL lock wait. This is consistent with the application retaining checked-out connections after committing joins and waiting for additional pool connections to build Event detail.
- A subsequent `/api/rooms` read still failed to respond within two seconds.
- The old `/api/healthz` returned HTTP 200 in 42 ms despite the blocked database-backed requests.
- The observer could not inspect the API pool's internal checkout queue. Connection counts alone do not prove checkout state; the persistent HTTP hang and audited nested-acquisition path provide the additional evidence.

The development API was restarted to recover. Cleanup then removed only the synthetic facilitator, its Event, linked games, tokens, and seats using the guarded fixture manifest. No real accounts or games were targeted.

The reusable harness saves credential-free reports and cleanup manifests under ignored `scripts/results/`. Timed-out operations are reported separately from successful-request latency percentiles.

Development latency is preliminary and must be measured again on an isolated staging configuration matching the intended production setup: Autoscale capped at a maximum of one server (instance). Autoscale may scale to zero when idle, so cold-start latency after a quiet period also needs separate measurement. A single always-on Reserved VM is an equivalent single-instance alternative, not a production requirement.

## Held-client fix proof and final validation

The same initial burst passed after the held-client locking changes and before timeout configuration: 106 successful requests, zero errors/timeouts, presence p95 203.5 ms and action p95 26.8 ms. That earlier scenario removed one guest; it is not the final full-occupancy validation.

The historical 60-second command above belongs to the original reproduction harness. The expanded harness now needs at least 120 seconds of deadline allowance because it measures actual 45-second heartbeat absence and recovery. Use the current commands in `scripts/DEVELOPMENT_EVENT_LOADTEST.md`.

The final 16- and 32-seat results, safeguard fault measurements, limitations and single-instance deployment guidance are recorded in `docs/event-reliability-validation.html`.