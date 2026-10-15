---
name: Game analytics semantics
description: Counting and historical-coverage decisions for shared-device game analytics.
---

Count distinct game IDs, not raw lifecycle event rows. Creation is separate from starting a waiting room; a host ending a room is separate from a game won.

**Why:** Historical completion events included duplicates, while bot and timer endings were missed by action-route-only logging. Resetting a room retains its game ID, so distinct-game totals are not a count of every replay.

**How to apply:** Capture lifecycle milestones with durable game persistence, reuse its held client and transaction, and make retries idempotent. Keep raw event-log reports clearly separate from canonical lifecycle totals.

Human engagement means a human finishing their own turn or winning during it. Drawing alone, bot progress, timer expiry, and host seat controls are not human engagement. Starting seat composition is not a count of unique people.

**Why:** Pass & Play can use a shared device without accounts; unattended automation must not inflate engagement, and temporary bot cover must not rewrite the starting human/bot mix.

**How to apply:** Use tracked human starts as the engagement denominator. Keep synthetic automated-test games out of reported lifecycle totals; do not add browser identifiers or per-player tracking without further authorization.

Historical first-turn times and elapsed durations are unknown unless tracking observed the game's start. Do not infer them from late saves or old event timestamps. Elapsed duration is wall-clock time, not active-play time.

**Why:** Past event logs did not reliably capture these milestones; reporting inferred values as measured data would mislead the user.

**How to apply:** Retain deduplicated historical creation/completion totals, label coverage limitations, and exclude unknown timing from engagement/completion rates and duration averages.
