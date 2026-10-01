import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import express from "express";
import { databaseSafeguardErrorHandler } from "../lib/databaseSafeguardErrorHandler.js";
import { acquireDatabaseClient } from "../lib/databaseSafeguards.js";
import type { PgClient } from "../lib/gameStore.js";

type JsonResponse = { status: number; body: unknown };

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not bind the isolated database test server"));
        return;
      }
      resolve(address.port);
    });
  });
}

function requestJson(port: number, path: string, timeoutMs = 8_000): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) as unknown });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Database safeguard test request timed out")));
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function runDevelopmentDatabaseChecks(): Promise<void> {
  if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT_ID) {
    throw new Error("Refusing database health integration checks outside the development workspace");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must point to the development workspace database");
  }

  const [{ pool }, { withGameMutationLocks }] = await Promise.all([
    import("@workspace/db"),
    import("../lib/gameStore.js"),
  ]);
  await import("../lib/poolMonitoring.js");

  const poolOptions = (pool as unknown as {
    options: { max: number; connectionTimeoutMillis: number };
  }).options;
  assert.equal(poolOptions.max, 10, "integration scenario relies on the configured ten-client pool");
  assert.equal(poolOptions.connectionTimeoutMillis, 5_000);

  const app = express();
  let mutationActionApplied = false;
  const gameId = `health-readiness-lock-test-${process.pid}-${Date.now()}`;
  const observedTimings = { acquisitionMs: 0, advisoryLockMs: 0, statementMs: 0 };

  app.get("/acquire", async (_req, res, next) => {
    let client: PgClient | undefined;
    try {
      client = await acquireDatabaseClient(() => pool.connect());
      res.json({ status: "ok" });
    } catch (error) {
      next(error);
    } finally {
      client?.release();
    }
  });

  app.get("/advisory-lock", async (_req, res, next) => {
    try {
      const outcome = await withGameMutationLocks([gameId], async () => {
        mutationActionApplied = true;
        return "applied";
      });
      res.json({ outcome });
    } catch (error) {
      next(error);
    }
  });

  app.use(databaseSafeguardErrorHandler);
  const server = createServer(app);
  const port = await listen(server);

  try {
    const leasedClients: PgClient[] = [];
    try {
      for (let index = 0; index < 10; index++) {
        leasedClients.push(await pool.connect());
      }

      const startedAt = Date.now();
      const acquisitionResponse = await requestJson(port, "/acquire", 7_500);
      const acquisitionElapsedMs = Date.now() - startedAt;
      observedTimings.acquisitionMs = acquisitionElapsedMs;
      assert.equal(acquisitionResponse.status, 503);
      assert.deepEqual(acquisitionResponse.body, {
        error: "Database temporarily unavailable",
        notApplied: true,
      });
      assert.ok(
        acquisitionElapsedMs >= 4_500 && acquisitionElapsedMs < 7_000,
        `pool acquisition timeout should be about 5 seconds, got ${acquisitionElapsedMs}ms`,
      );
    } finally {
      for (const client of leasedClients.reverse()) client.release();
    }

    const recoveredClient = await pool.connect();
    try {
      const recoveryProbe = await recoveredClient.query("SELECT 1 AS recovered");
      assert.equal(recoveryProbe.rows[0]?.recovered, 1);
    } finally {
      recoveredClient.release();
    }

    const lockHolder = await pool.connect();
    let advisoryLockHeld = false;
    let holderDestroyError: Error | undefined;
    try {
      await lockHolder.query(
        "SELECT pg_advisory_lock(7419, hashtext($1))",
        [gameId],
      );
      advisoryLockHeld = true;

      const startedAt = Date.now();
      const lockResponse = await requestJson(port, "/advisory-lock");
      const lockElapsedMs = Date.now() - startedAt;
      observedTimings.advisoryLockMs = lockElapsedMs;
      assert.equal(lockResponse.status, 503);
      assert.deepEqual(lockResponse.body, {
        error: "Database temporarily unavailable",
        notApplied: true,
      });
      assert.equal(mutationActionApplied, false, "pre-lock timeout never starts the mutation callback");
      assert.ok(
        lockElapsedMs >= 1_500 && lockElapsedMs < 4_500,
        `advisory lock timeout should be about 2 seconds, got ${lockElapsedMs}ms`,
      );
    } finally {
      try {
        if (advisoryLockHeld) {
          const unlock = await lockHolder.query(
            "SELECT pg_advisory_unlock(7419, hashtext($1)) AS unlocked",
            [gameId],
          );
          assert.equal(unlock.rows[0]?.unlocked, true);
        }
      } catch (error) {
        holderDestroyError = error instanceof Error ? error : new Error("Advisory lock cleanup failed");
        throw error;
      } finally {
        lockHolder.release(holderDestroyError);
      }
    }

    const statementClient = await pool.connect();
    let statementError: unknown;
    const statementStartedAt = Date.now();
    try {
      await statementClient.query("SELECT pg_sleep(7)");
      assert.fail("pg_sleep should be cancelled by the configured statement timeout");
    } catch (error) {
      statementError = error;
    } finally {
      statementClient.release();
    }
    const statementElapsedMs = Date.now() - statementStartedAt;
    observedTimings.statementMs = statementElapsedMs;
    assert.equal(errorCode(statementError), "57014");
    assert.ok(
      statementElapsedMs >= 4_500 && statementElapsedMs < 7_000,
      `statement timeout should be about 5 seconds, got ${statementElapsedMs}ms`,
    );
  } finally {
    await closeServer(server);
    await pool.end();
  }

  process.stdout.write(
    `Development database health safeguards passed: acquisition=${observedTimings.acquisitionMs}ms with recovery, advisory-lock=${observedTimings.advisoryLockMs}ms with notApplied, statement=${observedTimings.statementMs}ms (57014).\n`,
  );
}

if (process.env.RUN_DEV_DB_HEALTH_INTEGRATION === "1") {
  await runDevelopmentDatabaseChecks();
} else {
  process.stdout.write(
    "Skipped real-database health safeguards; set RUN_DEV_DB_HEALTH_INTEGRATION=1 against the development database to run.\n",
  );
}