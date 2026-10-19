---
name: Replay round boundaries
description: Product and privacy rules for playing another round in the same room.
---

Hosts may start another finished round in regular rooms and tables in open events. Keep the room link, seat identities, bot coverage, and room settings. Save previous final standings, not private hand snapshots.

**Why:** The user approved a Play again flow without making participants rejoin. Keeping raw private snapshots in shared round history would bypass per-viewer hand redaction.

**How to apply:** Distinguish room identity from played-round identity. Preserve prior results and count each new round separately. Reject non-host restarts, unfinished-round resets, and replays after an event starts ending.

Finishing every table does not close an event; the host explicitly ends it.

**Why:** Automatic completion would immediately prevent Play again at the last table to finish.

**How to apply:** Keep naturally finished tables restartable while the event is open. Never reopen an already closed event merely to enable replay.
