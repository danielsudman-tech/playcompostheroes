---
name: Event mutation consistency
description: Why event-table gameplay writes must coordinate with joins, and why generic schema push is unsafe here
---

- **All mutations of an event-linked game must coordinate across the event and ordinary game routes using a database-level per-game lock.** **Why:** the state is stored as one JSON document, so a concurrent guest join and a game start, end, or action can otherwise overwrite each other despite route-local locks or in-memory coordination. **How to apply:** acquire the shared lock and reload durable state before changing an event table; keep event seat, token, and state changes in sync when guests leave or transfer.
- **Treat generic development schema push prompts as unsafe for this project's legacy raw-SQL game tables.** **Why:** Drizzle proposed a rename involving unrelated existing tables when adding the event tables, which could have damaged persistent game data. **How to apply:** review proposed changes, add only intended new tables and indexes to development, and use the managed Publish schema flow for production; never force a broad push just to create event tables.