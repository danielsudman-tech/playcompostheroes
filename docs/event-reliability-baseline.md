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

Development latency is preliminary and must be measured again on the intended Reserved VM.