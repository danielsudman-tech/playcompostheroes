# Card Effect Systems Map

**Scope:** every card design in Compost Heroes, classified into reusable interaction
patterns that drive the *facilitated* game mode's guided play-a-card experience.

The deck is built from **42 unique card designs** (24 Heroes + 18 Actions) in
`artifacts/api-server/src/lib/cards.ts`. Copy counts are configurable via
`cardCopies.json` (admin panel). With the current configuration (10 designs at
2 copies each) the physical deck totals **52 cards**.

> Guiding principle: **automate rule execution, not player decision-making.**
> The engine auto-resolves anything with no meaningful choice; every genuine
> choice becomes a guided decision step showing only legal options.

## Interaction patterns

| Pattern | Description | UI treatment (facilitated) |
|---|---|---|
| **AUTO** | No choice — engine resolves instantly | Announcement banner only |
| **CHOOSE-HAND** | Pick card(s) from own hand | Guided card picker (hand) |
| **CHOOSE-DISCARD** | Pick a card from the discard pile | Guided card picker (discard browser) |
| **CHOOSE-PLAYER** | Pick a target player | Guided player picker |
| **PLAYER→CARD** | Pick a player, then one of their cards | 2-step guided chain |
| **MULTI-SELECT** | Pick N cards (fixed or optional count) | Multi-select picker with counter |
| **FUNCTION-SLOT** | Multi-function hero: choose which pile slot it fills | Function button grid |
| **ONGOING** | Passive/activatable effect that persists | Ongoing-slot banner; activation announcement |
| **ALL-PLAYER** | Affects every player; may cascade per-player decisions | Broadcast announcement + per-player waiting states |

`Decision types` below are the engine's `PendingDecision.type` values
(`gameEngine.ts`); "Auto" means no decision is created.

## Hero cards (24)

| Card | Effect (yellow text) | Pattern | Auto / Decision | Decision chain | Spectators see |
|---|---|---|---|---|---|
| The Breezy Bandit | Swap 1 card from another player's pile with 1 from yours | PLAYER→CARD (3-step) | Decision | `choose_swap_opponent_breezy` → `choose_swap_their_card_breezy` → `choose_swap_my_card_breezy` | Swap arrows between the two piles |
| Fresh-Air Friend | Discard 1 from hand, draw 2 | CHOOSE-HAND | Decision | `choose_card_from_hand` | Discarded card + "+2 cards" |
| Branch Buddy | Discard 1 from hand, draw 1 | CHOOSE-HAND | Decision | `choose_card_from_hand` | Discarded card + "+1 card" |
| The Soggy Saver | Moisture cards can't be removed from your pile | ONGOING (passive) | Auto | — | Shield badge on player's Moisture slot |
| Sir Stink-No-More | Unaffected by Stinky Pile | ONGOING (passive) + FUNCTION-SLOT | Decision (slot only) | `choose_function` | Immunity badge |
| The Wiggly Worker | Draw 1 extra card | AUTO + FUNCTION-SLOT | Decision (slot only) | `choose_function` | "+1 card" |
| Biochar | Take 1 Moisture card from discard | CHOOSE-DISCARD | Decision (auto-skips if none) | `choose_card_from_discard` | Card moving discard → hand (face-up) |
| Major Brown | Unaffected by Soggy Pile | ONGOING (passive) | Auto | — | Immunity badge |
| Brown Rogue | Take 1 Nitrogen from any player's pile to your hand | PLAYER→CARD | Decision | `choose_opponent_for_steal` → `choose_steal_card` | Card leaving target's pile |
| Stink Shield | Unaffected by Soggy Pile and Stinky Pile | ONGOING (passive) | Auto | — | Immunity badge |
| Mycelial Alchemist | All players discard 1 Decomposer from pile | ALL-PLAYER + FUNCTION-SLOT | Auto (effect) / Decision (slot) | `choose_function` | Each affected pile losing its Decomposer |
| The Under-Web | Swap 1 hand card with 1 discard card | CHOOSE-HAND → CHOOSE-DISCARD (2-step) + FUNCTION-SLOT | Decision | `choose_under_web_hand_card` → `choose_under_web_discard_card` (+ `choose_function`) | Only the discard side (hand card stays hidden) |
| Actinomycetes | Play 1 Hero from discard into your pile | CHOOSE-DISCARD (may chain slot) | Decision | `choose_hero_from_discard` (→ `choose_function`) | Hero moving discard → pile |
| The Catalyst | 2 Decomposers in pile → take another turn | AUTO (conditional) | Auto | — | "Extra turn" announcement |
| The Hot Head | Each Carbon discard → draw 1 | ONGOING (triggered) | Auto | — | Trigger announcements |
| The Old Timer | Max hand size 6 | ONGOING (passive) | Auto | — | Hand-size badge |
| Captain Nectar | Skip the next player's turn | AUTO | Auto | — | Skip marker on next player |
| The Hydro-Hauler | All players draw 1 | ALL-PLAYER | Auto | — | "+1 card" on every player |
| The Slumber-Soaker | 1 Decomposer in pile → draw 1 | AUTO (conditional) | Auto | — | "+1 card" or "no effect" |
| The Microbial Marshal | First card in your pile → draw 2 | AUTO (conditional) + FUNCTION-SLOT | Decision (slot only) | `choose_function` | "+2 cards" or "no effect" |
| The Brown Bomber | 1 Carbon in pile → draw 1 | AUTO (conditional) | Auto | — | "+1 card" or "no effect" |
| The Anaerobic Tyrant | 1 Decomposer or Carbon in pile → draw 1 | AUTO (conditional) | Auto | — | "+1 card" or "no effect" |
| The Legion of Life | Discard the active Ongoing Action card | AUTO + FUNCTION-SLOT | Decision (slot only) | `choose_function` | Ongoing slot emptying |
| The Quencher | Moisture played into your pile → draw 1 extra | ONGOING (triggered) + FUNCTION-SLOT | Decision (slot only) | `choose_function` | Trigger announcements |

## Action cards (18)

| Card | Effect (yellow text) | Pattern | Auto / Decision | Decision chain | Spectators see |
|---|---|---|---|---|---|
| Anaerobic Pocket | Discard 1 Airflow from your pile, then an opponent skips next turn | CHOOSE-HAND(pile) → CHOOSE-PLAYER (2-step) | Decision | `choose_card_from_compost` → `choose_target_player` | Pile card → discard; skip marker |
| Carbon Sink | 2 Carbons in pile → take a Nitrogen from an opponent's pile | PLAYER→CARD (conditional) | Decision (auto-skips if condition unmet) | `choose_opponent_for_steal` → `choose_steal_card` | Card moving between piles |
| Critical Mass | 2 same-layer cards in pile → may draw 1 | ONGOING (activatable) | Auto on activate | — | Activation announcement |
| Critter Raid | All players discard 1 Nitrogen from hand | ALL-PLAYER | Auto | — | Each affected player's discard (count) |
| Dry Spell | No Moisture in pile → max hand 3 | ONGOING (global modifier) | Auto (enforced at end of turn via `choose_discard_to_limit`) | `choose_discard_to_limit` | Hand-limit badges |
| High Heat Gamble | Draw 3; no Decomposers → skip next turn | AUTO (gamble) | Auto | — | "+3 cards" + skip result |
| Hot Pile Bonus | 2 Decomposers in pile → may draw 1 extra per turn | ONGOING (activatable) | Auto on activate | — | Activation announcement |
| Nitrogen Boost | May discard 1 Nitrogen from hand to draw 2 | ONGOING (activatable) | Decision on activate | `choose_nitrogen_boost_discard` | Discard + "+2 cards" |
| Plastic Contamination | No player may add heroes to pile | ONGOING (global modifier) | Auto | — | Block badge on all piles |
| Rainstorm | Draw 2; may play Moisture/Nitrogen drawn immediately | MULTI-SELECT (optional) | Decision | `choose_rainstorm_play` | Cards played into pile (played ones only) |
| Rot & Regrow | May discard 3 from hand to take 1 from discard | ONGOING (activatable) → MULTI-SELECT + CHOOSE-DISCARD | Decision on activate | `choose_rot_regrow_discard` (pick 3) → `choose_rot_regrow_take` | 3 → discard, 1 ← discard |
| Soggy Pile | Each player discards 1 Moisture OR 1 Nitrogen from pile | ALL-PLAYER (cascading decisions) | Per-player decision | `choose_soggy_pile_discard` per affected player | Each pile's loss; immunity badges honored |
| Spread Nutrients | Give 1 hand card to each player; draw same number | MULTI-SELECT (fixed = player count − 1) | Decision | `choose_discard_for_spread` | Transfer arrows to each player (faces hidden) |
| Stinky Pile | Each player discards 1 Nitrogen from pile | ALL-PLAYER | Auto | — | Each pile's loss; immunity badges honored |
| Time Warp | Take another full turn | AUTO | Auto | — | "Extra turn" announcement |
| Worm Party | Each player passes 1 hand card left | ALL-PLAYER (cascading decisions) | Per-player decision | `choose_worm_party_card` per player | Pass arrows around the table (faces hidden) |
| Pile Flip | All piles pass left | ALL-PLAYER | Auto | — | Whole-pile rotation animation |
| Rot Roulette | Draw 5, discard 3, keep 2, play 1 now | MULTI-SELECT (fixed 2) → CHOOSE-HAND | Decision | `choose_rot_roulette_keep` → `choose_card_from_hand` (play) | Discarded 3 (face-up) + the played card |

## Cross-cutting decisions

| Trigger | Decision type | Pattern |
|---|---|---|
| Multi-function hero enters pile | `choose_function` | FUNCTION-SLOT |
| Player moves a pile card between slots | `choose_move_function` | FUNCTION-SLOT |
| Hand over limit at end of turn (incl. Dry Spell) | `choose_discard_to_limit` | MULTI-SELECT (fixed) |

## Facilitated-mode contract

- **Announcement:** every card play broadcasts `lastEffect` on the game state
  (card, yellow `cardText`, plain-language outcome lines, structured events) via
  the existing SSE stream — all players and spectators see it.
- **Guided decisions:** `pendingDecision` is visible to everyone; the deciding
  player gets the step-by-step panel (step X of Y for chained decisions, only
  legal options served by the engine); everyone else sees
  "*«name» is choosing…*" with the prompt.
- **Spectator visualization:** `lastEffect.events` encode draws, discards,
  transfers, swaps, skips and pile shifts so clients can animate them without
  revealing hidden hands.
- Hidden information rules match online mode: opponents' hands are serialized
  as card backs; discard pile and compost piles are public.
