import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { WORKSPACE_ROOT } from "./workspaceRoot.js";

// Always stored next to the source file — works in both dev (tsx) and prod (bundled dist)
// because WORKSPACE_ROOT walks up from __dirname until it finds pnpm-workspace.yaml.
const JSON_PATH = join(WORKSPACE_ROOT, "artifacts/api-server/src/lib/cardCopies.json");

let copies: Record<string, number> = {};

function load() {
  try {
    copies = JSON.parse(readFileSync(JSON_PATH, "utf-8"));
  } catch {
    copies = {};
  }
}

function save() {
  writeFileSync(JSON_PATH, JSON.stringify(copies, null, 2), "utf-8");
}

load();

export function getCardCopies(cardId: string): number {
  return copies[cardId] ?? 1;
}

export function setCardCopies(cardId: string, count: number): void {
  if (count < 0) count = 0;
  copies[cardId] = count;
  save();
}

export function getAllCopies(): Record<string, number> {
  return { ...copies };
}
