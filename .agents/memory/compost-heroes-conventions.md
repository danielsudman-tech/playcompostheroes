---
name: Compost Heroes conventions
description: Durable architectural decisions for the Compost Heroes game
---

- **Facilitated mode reuses the online multiplayer flow rather than a parallel stack.** **Why:** existing online play must remain untouched, and two multiplayer stacks would drift. **How to apply:** treat facilitated as a superset of online behavior; any multiplayer gate should include both modes, and any per-viewer serialization (hidden information) must go through the single shared serialization path so all transports stay consistent.
- **Hidden information must be redacted per viewer, not per zone.** **Why:** decision prompts and options can carry hand-derived card identities even when hands themselves are hidden — a past review caught this leak. **How to apply:** when adding any new field to the broadcast game state, ask whether a non-owner viewer could infer hidden cards from it.
- **The API contract is spec-first.** **Why:** the spec once lagged the server, forcing type escapes in the frontend. **How to apply:** change the OpenAPI spec and regenerate clients in the same task as any server response-shape change.
