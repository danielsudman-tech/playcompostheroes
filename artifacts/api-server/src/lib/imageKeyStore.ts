import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { WORKSPACE_ROOT } from "./workspaceRoot.js";

const JSON_PATH = join(WORKSPACE_ROOT, "artifacts/api-server/src/lib/imageKeys.json");

let overrides: Record<string, string> = {};

function loadOverrides() {
  try {
    const raw = readFileSync(JSON_PATH, "utf-8");
    overrides = JSON.parse(raw);
  } catch {
    overrides = {};
  }
}

function saveOverrides() {
  writeFileSync(JSON_PATH, JSON.stringify(overrides, null, 2), "utf-8");
}

loadOverrides();

export function getImageKeyOverride(cardId: string): string | null {
  return overrides[cardId] ?? null;
}

export function setImageKeyOverride(cardId: string, imageKey: string): void {
  overrides[cardId] = imageKey;
  saveOverrides();
}

export function removeImageKeyOverride(cardId: string): void {
  delete overrides[cardId];
  saveOverrides();
}

export function getAllOverrides(): Record<string, string> {
  return { ...overrides };
}
