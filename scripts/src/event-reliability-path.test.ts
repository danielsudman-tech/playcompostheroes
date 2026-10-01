import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveFixtureManifestPath } from "./event-reliability-support.js";

test("resolves workspace-relative fixture paths from either workspace root or scripts cwd", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "event-reliability-path-"));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));

  const workspaceRoot = join(temporaryRoot, "workspace");
  const scriptsRoot = join(workspaceRoot, "scripts");
  const resultsDirectory = join(scriptsRoot, "results");
  const manifestName = "event-reliability-test.fixtures.json";
  const manifestPath = join(resultsDirectory, manifestName);
  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(manifestPath, "{}\n");

  const workspaceRelativePath = `scripts/results/${manifestName}`;
  const fromWorkspaceRoot = await resolveFixtureManifestPath(
    workspaceRelativePath,
    scriptsRoot,
    workspaceRoot,
  );
  const fromScriptsDirectory = await resolveFixtureManifestPath(
    workspaceRelativePath,
    scriptsRoot,
    scriptsRoot,
  );
  const fromResultsDirectory = await resolveFixtureManifestPath(
    `results/${manifestName}`,
    scriptsRoot,
    scriptsRoot,
  );

  assert.equal(fromWorkspaceRoot, manifestPath);
  assert.equal(fromScriptsDirectory, manifestPath);
  assert.equal(fromResultsDirectory, manifestPath);

  const outsideManifest = join(temporaryRoot, "outside.fixtures.json");
  await writeFile(outsideManifest, "{}\n");
  await symlink(outsideManifest, join(resultsDirectory, "escaped.fixtures.json"));
  await assert.rejects(
    resolveFixtureManifestPath(
      "scripts/results/escaped.fixtures.json",
      scriptsRoot,
      scriptsRoot,
    ),
    /directly inside scripts\/results/,
  );
});