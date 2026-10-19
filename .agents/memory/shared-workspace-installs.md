---
name: Shared workspace installs
description: Dependency changes for a new artifact can affect existing development services.
---

Treat adding an artifact's dependencies as a workspace-wide development dependency change, even when installing with a package filter.

**Why:** A filtered installation changed shared Vite peer resolution and left the existing game service pointing at a removed dependency path. Completing the full workspace installation and restarting the affected service restored it without source changes.

**How to apply:** After adding artifact dependencies, ensure the full workspace installation agrees with the lockfile and check existing development services, not just the new artifact. Do not infer a game source bug from a stale dependency-path error.
