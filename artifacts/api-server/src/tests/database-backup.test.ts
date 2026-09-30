import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseDump } from "../lib/databaseBackup.js";

const before = new Set((await readdir(tmpdir())).filter((entry) => entry.startsWith("compost-db-backup-")));
await assert.rejects(
  createDatabaseDump(
    "unused",
    process.execPath,
    ["-e", "process.stdout.write('partial SQL'); process.exitCode = 7"],
  ),
  /pg_dump exited with code 7/,
);
const after = (await readdir(tmpdir())).filter((entry) => entry.startsWith("compost-db-backup-"));
assert.deepEqual(after.filter((entry) => !before.has(entry)), [], "failed dumps remove partial temp files");

const completed = await createDatabaseDump(
  "unused",
  process.execPath,
  ["-e", "process.stdout.write('complete SQL')"],
);
try {
  assert.equal(await readFile(completed.path, "utf8"), "complete SQL");
} finally {
  await completed.cleanup();
}

console.log("database backup tests passed");