import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

function findWorkspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Cannot find workspace root (pnpm-workspace.yaml not found)");
    dir = parent;
  }
}

export const WORKSPACE_ROOT = findWorkspaceRoot();
