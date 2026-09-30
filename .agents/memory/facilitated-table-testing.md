---
name: Facilitated table testing
description: How to screenshot/test a facilitated game table without using account-token links
---
Facilitated players do not need an account; Online players do. To screenshot/test a facilitated game table, use a valid `?token=<seat token>` in the route if needed. Never put a user sign-in token in `?ut=` — the URL sign-in import has been removed. A facilitator account must sign in through the form or an established browser session to open host controls.

**Why:** account credentials in URLs leak via copied links and browser history, and guest seats have their own access path.
**How to apply:** any visual verification of `/game/:id/table` or `/game/:id/host`.

Layout rule: the facilitated table is sized so 4 players fit a 900px-tall laptop window with zero scrolling — the local player's row is pinned above the hand footer; only opponent rows scroll. Keep this budget when adding board UI.
