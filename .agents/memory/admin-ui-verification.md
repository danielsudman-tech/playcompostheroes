---
name: Admin UI verification
description: Constraint on checking authenticated admin pages with browser automation.
---

The browser testing agent could not transfer the workspace admin secret into its Playwright session without exposing or writing it. It stopped at the admin sign-in screen rather than inspecting the protected panel. An environment-backed HTTP client can still validate admin API behavior without printing the secret.

**Why:** Admin-gated visual checks otherwise appear to be straightforward, but the credential boundary blocked the browser session; pretending the protected panel was visually inspected would misstate verification.

**How to apply:** For admin UI changes, use type checks, source inspection, unauthenticated screenshots, and temporary-account API checks as appropriate. Only claim authenticated browser verification if a safe credential injection path exists; never expose a real admin secret to make a screenshot work.