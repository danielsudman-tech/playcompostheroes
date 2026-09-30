import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pipeline } from "stream/promises";

export type DatabaseDump = { path: string; cleanup(): Promise<void> };

/** Resolve only after pg_dump exited successfully and its complete output file
 * is closed. On failure, remove partial output and reject so callers cannot
 * accidentally send a truncated dump as a successful attachment.
 */
export async function createDatabaseDump(
  databaseUrl: string,
  command = "pg_dump",
  commandArgs: string[] = ["--no-password", databaseUrl],
): Promise<DatabaseDump> {
  const directory = await mkdtemp(join(tmpdir(), "compost-db-backup-"));
  const outputPath = join(directory, "backup.sql");
  try {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", (chunk: Buffer) => {
      // Keep stderr drained so pg_dump cannot block if it reports diagnostics.
      void chunk;
    });
    const processFinished = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pg_dump exited with code ${code}`));
      });
    });
    const outputFinished = pipeline(child.stdout, createWriteStream(outputPath, { flags: "wx" }));
    const results = await Promise.allSettled([processFinished, outputFinished]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return {
      path: outputPath,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}