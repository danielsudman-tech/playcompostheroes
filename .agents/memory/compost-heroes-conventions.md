---
name: Compost Heroes conventions
description: Durable architectural decisions for the Compost Heroes game
---

- **Facilitated mode reuses the online multiplayer flow rather than a parallel stack.** **Why:** existing online play must remain untouched, and two multiplayer stacks would drift. **How to apply:** treat facilitated as a superset of online behavior; any multiplayer gate should include both modes, and any per-viewer serialization (hidden information) must go through the single shared serialization path so all transports stay consistent.
- **Hidden information must be redacted per viewer, not per zone.** **Why:** decision prompts and options can carry hand-derived card identities even when hands themselves are hidden — a past review caught this leak. **How to apply:** when adding any new field to the broadcast game state, ask whether a non-owner viewer could infer hidden cards from it.
- **Facilitated rooms have a dedicated Zoom-friendly table screen at `/game/:id/table`; the standard game screen redirects facilitated players there once play starts.** **Why:** online play must stay untouched while facilitated play is optimized for half-screen laptop windows beside Zoom/Teams. **How to apply:** facilitated-only UI work goes in the table screen (and its `facilitated/` components), not Game.tsx; the table reuses the shared hooks/DecisionModal so engine changes propagate to both.
- **Identity tokens can be seeded via URL query (`?ut=` user token on any page, `?token=` seat token on the table route); they are validated server-side, stored, then stripped from the URL.** **Why:** facilitators distribute per-player links over Zoom chat, and automated screenshots need a way in past the localStorage-only gates. **How to apply:** for testing or share-links, build `/game/:id/table?ut=...&token=...` instead of adding new bypasses.
- **Facilitator assist controls (pause, step-in resolve, nudge) live on host-gated endpoints; step-in resolves auto-pick server-side.** **Why:** the host is also a seated player, so showing them another player's decision options would leak hand-derived cards; picking a sensible option on the server (skip when optional, first option otherwise) keeps hidden info intact. **How to apply:** new facilitator powers go through the host-token (player index 0) gate and must never surface redacted decision options to the host client; the dashboard lives at `/game/:id/host`.
- **The API contract is spec-first.** **Why:** the spec once lagged the server, forcing type escapes in the frontend. **How to apply:** change the OpenAPI spec and regenerate clients in the same task as any server response-shape change.

## Registration rules (Aug 2026)
- Lobby "/" is ungated; Pass & Play needs no account. Online requires sign-in — enforced server-side (create/join/claim take `userToken`, validated via userStore) AND client-side (AppGate gates /game/:id only when game mode is online; `?signin=1` forces the gate UI from ungated pages).
- Facilitated: participants join with session code (= gameId) + name only via the lobby's "Have a code?" screen → /game/:code/table; hosting requires an account.
**Why:** product policy from Danny's landing-page spec — zero friction for participants, accountability for hosts/online play.

## Facilitator session management
- Facilitated sessions carry `facilitatorId` (account id), `label`, `createdAt`, `endedAt` in GameState; `storeGame` stamps `endedAt` on any `game_over`. Resets must preserve this metadata or the room drops off the creator's dashboard.
- Host capability = seat-0 token, but the creator can re-mint it from any device via account-authorized host-token recovery — never rely solely on localStorage tokens for facilitator re-entry.
- Participant questions are facilitator-directed: `serializeState` redacts them so non-host viewers only see their own. Any new facilitator-directed field must be redacted the same way (public GET + SSE both go through serializeState).
- After `game_over` (natural or host-ended), all gameplay/question/message mutations return 409; only `reset_game` is allowed.
