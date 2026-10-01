# Hot Pile, Game Updates, effect facts, and trivia

## Scope

Implemented in the shared `FacilitatedGame` table. Development only: no publishing, deployment configuration changes, sandbox changes, or shared-gameplay migration.

## Verification

- Rules regression: the original Legion implementation failed the instance-identity assertion, discarding a template instead of the real ongoing instance. The repaired version passes, including missing modifiers, instance-valued modifiers, Plastic Contamination, and saved/reloaded usage.
- Hot Pile counts each eligible pile card once: native Decomposer, chosen Decomposer slot, or an alternate Decomposer function. Other cards' function-count rules are unchanged. Activation remains manual, in the play phase, once per turn, for any eligible player.
- Full regression run: all 35 API, client, and reliability test files passed, including the opt-in development database health integration. Workspace typecheck and whitespace checks passed.
- Subsequent focused checks cover bot draw provenance, combined human/bot traces, action-play costs, reshuffles, and same-instance redraws. No operation trace is persisted or sent to clients.
- Trivia has 24 static questions checked against their card facts. Its 13 local session/availability checks cover storage failures, cycling, answer checking, resuming, decision/turn gating, and default settings.
- Desktop 1440×900 and mobile 402×874 browser checks confirmed manual activation sends one action, draws one card, disables the used benefit, and produces plain-language Updates without a confirmation overlay.
- Pass & Play browser checks confirmed an opaque handoff, no private hand footer before Reveal, one inline group quiz, keyboard focus containment, and no implicit Reveal when closing trivia.
- Remote browser checks confirmed closing trivia on the player's turn and restoring the same question, checked answer, and explanation when waiting resumed. Owner A/B receipts were isolated in one document with the existing query provider still mounted.
- First-attempt same-document A→Home→B→Home→A navigation passed after fixing the claim race. On mobile, the waiting Learn button was immediately above the hand and accessible with Controls collapsed.
- Measured answer selection, Check, Next, and reopen windows each had zero fetch/XHR requests. Existing background game-state polling continues independently; opening the lazy bundle can request its JavaScript once.
- Historical, provenance-free discard-to-hand announcements are redacted during serialization, not merely prevented in new announcements. New proven public selections retain their names; the internal trust marker is never sent to clients.
- Restart-time Vite warnings were not reproduced in a fresh screenshot context. Screenshot loading also reported an unidentified 404 resource; it did not prevent the table or handoff from rendering.

## Notification classification

| Interaction | Presentation |
| --- | --- |
| Card effects and ongoing activation | Non-blocking Game Updates |
| Turn starts and received nudges | Updates plus turn-control highlighting |
| Question, ready, and nudge success | Updates |
| Facilitator broadcast | Latest non-dismissible banner plus Updates |
| Required player choices | Required decision UI retained |
| Shared-device privacy handoff | Opaque Reveal screen retained |
| Game over | Results UI retained |
| User-opened cards, piles, discard, help, and Recap | User-controlled overlays retained |
| Request errors | Error notifications retained |

## Boundaries to preserve in a later shared-gameplay migration

- Keep one authoritative action per player decision and the existing transport, locks, and ordering safeguards.
- Keep private snapshots and notification records isolated by viewer credential, not just game or seat. Obsolete GET/SSE/mutation responses must not populate a different viewer's record.
- Preserve action-local operation provenance across human and bot execution. A card's previous zone does not establish whether a new hand gain was a random draw or an explicit public selection.
- Preserve the originating actor and activation verb through pending decision chains. The seat resolving a later choice is not necessarily the player who played or activated the card. Older saved contexts remain readable with optional-field defaults.
- Never infer hidden hand details from player names or legacy log grammar. Public pile details remain public; hand-derived details remain owner-scoped.
- Keep Hot Pile's broader eligibility predicate specific to Hot Pile.
- Trivia remains optional and client-side. Required input and active turns take priority, and Pass & Play trivia must remain inside the opaque handoff.
- `trivia_enabled` is an additive Event column, defaulting to true. The setting is written once on the Event; the game snapshot flag is a read-only projection, not a per-game/player/answer write.
- Event trivia settings currently use a hydrated process-local cache and existing SSE. If deployment architecture later gains multiple API processes, that cache needs shared invalidation; this change does not alter deployment settings.