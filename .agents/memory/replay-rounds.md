---
name: Replay round boundaries
description: Product and privacy rules for playing another round in the same room.
---

Hosts may start another finished round in regular rooms and tables in open events. Keep the room link, seat identities, bot coverage, and room settings. Save previous final standings, not private hand snapshots.

**Why:** The user approved a Play again flow without making participants rejoin. Keeping raw private snapshots in shared round history would bypass per-viewer hand redaction.

**How to apply:** Distinguish room identity from played-round identity. Preserve prior results and count each new round separately. Reject non-host restarts, unfinished-round resets, and replays after an event starts ending.

Hosts may remove or transfer players before play or between rounds. Transfers require both tables to be waiting or finished, with space at the destination, within the same open event or between the same host's standalone rooms.

**Why:** The user approved reorganizing workshop groups between rounds, not interrupting active games or moving guests between unrelated events.

**How to apply:** Save the original round's public standings before the first roster edit, and never overwrite or duplicate them during later edits or replay. Preserve the original winner even after that player leaves. Do not carry old hands or piles to the destination. Reset replay readiness after roster changes and require at least two players before restarting.

Finishing every table does not close an event; the host explicitly ends it.

**Why:** Automatic completion would immediately prevent Play again at the last table to finish.

**How to apply:** Keep naturally finished tables restartable while the event is open. Never reopen an already closed event merely to enable replay.

Post-round readiness is an optional coordination signal, not a vote or restart permission. A host may proceed before everyone is ready. Show disconnection and bot coverage separately rather than undoing a participant's explicit check-in on disconnect.

**Why:** The requested workshop ready check helps hosts coordinate breaks; it must not prevent a host from dealing or let guests restart.

**How to apply:** Keep post-round check-ins independent from event waiting-room readiness and require a fresh check-in for each finished round.
