---
name: Facilitator approval provenance
description: Historical account roles cannot prove an administrator approved the user.
---

Legacy account registration accepted a self-supplied role. Do not treat historical facilitator role text as authorization or bulk-approve those accounts during a future migration. Require an explicit admin-controlled approval marker in addition to the role.

**Why:** Before role enforcement was introduced, anyone could register with a facilitator role string. Granting those existing strings access would silently elevate accounts that were never approved by an admin.

**How to apply:** When modifying account migrations, role checks, or admin tooling, preserve the distinction between old profile role text and a deliberate admin approval. If replacing the current marker, migrate only verified approvals, not all facilitator strings.