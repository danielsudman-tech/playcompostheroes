---
name: Facilitated table testing
description: How to screenshot/test the facilitated game table behind the app gate
---
The web app is gated by user registration. To screenshot or test any in-game route headlessly, pass BOTH tokens in the URL: `?token=<seat/creator token>&ut=<user token>`. Get a user token via `POST /api/auth/register`; get a game + creator token via `POST /api/games` (mode `facilitated`), then `POST /api/games/:id/start` with `botSlots` to populate the board.

**Why:** a bare table URL renders the signup gate, making screenshots misleading.
**How to apply:** any visual verification of `/game/:id/table` or `/game/:id/host`.

Layout rule: the facilitated table is sized so 4 players fit a 900px-tall laptop window with zero scrolling — the local player's row is pinned above the hand footer; only opponent rows scroll. Keep this budget when adding board UI.
