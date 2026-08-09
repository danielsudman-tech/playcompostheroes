/**
 * Regression guard: every engine DecisionType must be handled by the web
 * DecisionModal (card/player/function selection sets) and have step metadata
 * in decisionSteps.ts, so no guided decision ever falls through to generic
 * buttons that submit the wrong payload shape.
 *
 * Run with: pnpm --filter @workspace/api-server run test:decision-coverage
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const engineSrc = readFileSync(path.join(here, "../lib/gameEngine.ts"), "utf8");
const modalSrc = readFileSync(
  path.join(here, "../../../compost-heroes/src/components/DecisionModal.tsx"),
  "utf8"
);
const stepsSrc = readFileSync(
  path.join(here, "../../../compost-heroes/src/lib/decisionSteps.ts"),
  "utf8"
);

// Extract the DecisionType union members from the engine.
const unionMatch = engineSrc.match(/export type DecisionType =([\s\S]*?);/);
assert.ok(unionMatch, "DecisionType union not found in gameEngine.ts");
const types = [...unionMatch![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
assert.ok(types.length >= 20, `unexpectedly few decision types parsed: ${types.length}`);

// Types the engine defines but never emits as a pendingDecision (legacy).
const NEVER_EMITTED = new Set(["choose_cards_for_worm_party"]);

const missingModal: string[] = [];
const missingSteps: string[] = [];
for (const t of types) {
  if (NEVER_EMITTED.has(t)) continue;
  if (!modalSrc.includes(`"${t}"`)) missingModal.push(t);
  if (!stepsSrc.includes(t)) missingSteps.push(t);
}

assert.deepEqual(
  missingModal,
  [],
  `DecisionModal does not handle these decision types (add to a selection set): ${missingModal.join(", ")}`
);
assert.deepEqual(
  missingSteps,
  [],
  `decisionSteps.ts lacks step metadata for: ${missingSteps.join(", ")}`
);

console.log(`decision-coverage.test.ts: all ${types.length} decision types covered ✔`);
