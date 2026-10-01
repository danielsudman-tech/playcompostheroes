---
name: Long browser waits
description: Browser test context persistence during timed presence checks
---
In multi-context workshop browser tests, avoid waiting more than about 45 seconds in one browser-runner step. Split presence expiry checks into shorter waits, or plan to restore a seat from its existing token after a runner reset.

**Why:** A long disconnect-heartbeat wait timed out the browser notebook and discarded all 16 saved browser contexts, although the app and database remained healthy.
**How to apply:** When checking guest presence expiry or rejoin in browser tests, preserve a recovery path for the original seat and keep individual waits short.