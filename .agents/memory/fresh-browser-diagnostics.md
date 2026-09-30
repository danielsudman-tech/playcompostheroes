---
name: Fresh browser diagnostics
description: Avoid diagnosing stale development HMR warnings as reproducible application defects.
---

When hooks change during an active browser session, confirm reported hook-order warnings with new console/error listeners and a fresh reload after the final workflow restart before restructuring otherwise unconditional hooks.

**Why:** A retained browser session reported a hook-order warning after live edits, but fresh reloads across loading, reveal, and gameplay emitted no warnings or errors. The existing hook sequences were unconditional.

**How to apply:** Recheck only the failing transition in the existing tester, not the entire previously passed gameplay journey. Treat errors that recur on a fresh reload as real defects; do not dismiss them as HMR noise.