# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   └── api-server/         # Express API server
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts (single workspace package)
│   └── src/                # Individual .ts scripts, run via `pnpm --filter @workspace/scripts run <script>`
├── pnpm-workspace.yaml     # pnpm workspace (artifacts/*, lib/*, lib/integrations/*, scripts)
├── tsconfig.base.json      # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly. Running `tsc` inside a single package will fail if its dependencies haven't been built yet.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite...etc, not `tsc`.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array. `tsc --build` uses this to determine build order and skip up-to-date packages.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers; `src/routes/health.ts` exposes `GET /health` (full path: `/api/health`)
- Depends on: `@workspace/db`, `@workspace/api-zod`
- `pnpm --filter @workspace/api-server run dev` — run the dev server
- `pnpm --filter @workspace/api-server run build` — production esbuild bundle (`dist/index.cjs`)
- Build bundles an allowlist of deps (express, cors, pg, drizzle-orm, zod, etc.) and externalizes the rest

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/index.ts` — creates a `Pool` + Drizzle instance, exports schema
- `src/schema/index.ts` — barrel re-export of all models
- `src/schema/<modelname>.ts` — table definitions with `drizzle-zod` insert schemas (no models definitions exist right now)
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL`, automatically provided by Replit)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

Production migrations are handled by Replit when publishing. In development, we just use `pnpm --filter @workspace/db run push`, and we fallback to `pnpm --filter @workspace/db run push-force`.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`). Running codegen produces output into two sibling packages:

1. `lib/api-client-react/src/generated/` — React Query hooks + fetch client
2. `lib/api-zod/src/generated/` — Zod schemas

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec (e.g. `HealthCheckResponse`). Used by `api-server` for response validation.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client from the OpenAPI spec (e.g. `useHealthCheck`, `healthCheck`).

### `scripts` (`@workspace/scripts`)

Utility scripts package. Each script is a `.ts` file in `src/` with a corresponding npm script in `package.json`. Run scripts via `pnpm --filter @workspace/scripts run <script>`. Scripts can import any workspace package (e.g., `@workspace/db`) by adding it as a dependency in `scripts/package.json`.

## Compost Heroes Game

**Artifact**: `artifacts/compost-heroes` (React + Vite, previewPath `/`)

A browser-based digital card game for 2–4 players. Players collect hero cards from 5 compost function categories into their pile. First to have 1 hero from each category wins.

### Game Architecture

- **Frontend**: React + Vite, with React Query for polling (1.5s) and mutations
- **Backend**: In-memory game state in `artifacts/api-server/src/lib/gameStore.ts`
- **Game Engine**: `artifacts/api-server/src/lib/gameEngine.ts` — complete card/turn logic
- **Cards**: 51 cards defined in `artifacts/api-server/src/lib/cards.ts` (34 hero + 17 action)
- **API**: POST /api/games, GET /api/games/:id, POST /api/games/:id/action

### Key Game Rules

- Win: collect 1 hero from each of 5 functions: Airflow, Carbon, Moisture, Nitrogen, Decomposer
- Turn flow: `draw` phase → draw card → `play` phase → play or skip → end turn → next player
- Action cards trigger `pendingDecision` which must be resolved before ending turn
- Modes: Pass & Play (local, turn-based), Facilitator (host controls view)

### Important Bugs Fixed

- `enforceHandSize`: infinite loop because `player` reference was stale inside while loop — fixed to refresh from state on each iteration
- `choose_rot_roulette_keep`: second step (play 1 of kept cards) now properly calls `playCard()` after clearing pending decision
- `DecisionModal`: rewrote with explicit type-based detection using `CARD_SELECTION_TYPES` / `PLAYER_SELECTION_TYPES` Sets instead of fragile string matching — `choose_rainstorm_play`, `choose_rot_roulette_keep`, `choose_discard_for_spread`, `choose_nitrogen_boost_discard` etc. now render card images correctly
- `choose_rainstorm_play`: now shows optional multi-select with "Skip (Play None)" and "Play X Selected" buttons; sends `{ cardIds: [] }` when skipped
- `choose_discard_for_spread`: now uses fixed-count multi-select (N = number of other players); sends `{ cardIds: string[] }` payload
- `choose_nitrogen_boost_discard`: backend now handles `{ skip: true }` gracefully; frontend shows Skip button
- `useGameAction`: added `GameActionCallbacks` with `onError(message)` callback; Game.tsx wires up destructive toast for action errors
- `targetPlayerId` mismatch: `handleSingleOption` in DecisionModal now remaps `opt.playerId` → `targetPlayerId` for player-selection decisions so backend `choose_target_player` handler receives the correct field
- `HoverableCard` hover clipping: rewrote to use `useRef` + `getBoundingClientRect()` + `createPortal` with `position: fixed` so the preview card renders at the correct screen position regardless of z-index stacking contexts

### Multi-Layer Hero Card Feature

Hero cards can now fill multiple compost function slots:

- **Card interface**: `Card.alternateFunctions?: string[]` lists additional slots a hero can fill; `Card.chosenFunction?: string` stores the player's choice (set on card when in compost pile)
- **`choose_function` decision**: when a hero with `alternateFunctions` is played, backend sets a pending decision showing all possible function slots as colored icon buttons
- **`choose_move_function` decision**: triggered by `move_card_layer` action — shows available alternate slots for a placed card; only offers unfilled slots
- **`move_card_layer` action**: new action type in GameAction; backend handler in `moveCardLayer()` validates the card has alternates and the target slot is empty; PlayerMat renders a small move button on multi-layer cards when it's the local player's turn
- **Win condition**: `getHasFunction()` and `getCountFunction()` use `chosenFunction ?? function` so chosen slot counts for win check
- **UI**: DecisionModal `FUNCTION_SELECTION_TYPES` set + `isFunctionSelection` renders a grid of colored function buttons with icons; `getCategoryCards` in PlayerMat uses `getEffectiveFn(card)` = `chosenFunction ?? function` so placed cards display in the correct slot; `CardState` type alias added to `api.schemas.ts`
