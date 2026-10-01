import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import express from "express";
import {
  createStartupReadiness,
  runStartupInitialization,
} from "../lib/startupReadiness.js";
import type { ReadinessPool } from "../lib/healthReadiness.js";

interface TestServer {
  port: number;
  close(): Promise<void>;
}

async function startApp(app: express.Express): Promise<TestServer> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function request(port: number, path: string): Promise<{ status: number; body: unknown }> {
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
    req.setTimeout(1_000, () => req.destroy(new Error("Startup readiness request timed out")));
  });
}

function createTestApp(gate: ReturnType<typeof createStartupReadiness>) {
  let dbProbes = 0;
  let productRequests = 0;
  const readinessPool: ReadinessPool = {
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
    async connect() {
      return {
        async query(sql: string) {
          assert.equal(sql, "SELECT 1");
          dbProbes += 1;
          return { rows: [{ "?column?": 1 }] };
        },
        release() {},
      };
    },
  };
  const app = express();
  app.use(
    "/api",
    createHealthRouter(readinessPool, () => "test-admin-key", 100, gate.isReady),
  );
  app.use("/api", gate.middleware);
  app.get("/api/product", (_req, res) => {
    productRequests += 1;
    res.json({ ok: true });
  });
  return {
    app,
    getDbProbes: () => dbProbes,
    getProductRequests: () => productRequests,
  };
}

process.env.DATABASE_URL ??= "postgres://health-test:health-test@127.0.0.1:1/health";
const { createHealthRouter } = await import("../routes/health.js");

{
  const gate = createStartupReadiness();
  gate.markStarting();
  let releaseMigrations!: () => void;
  let releaseCardSettings!: () => void;
  let migrationsStartedCardSettings!: () => void;
  const migrations = new Promise<void>((resolve) => { releaseMigrations = resolve; });
  const cardSettings = new Promise<void>((resolve) => { releaseCardSettings = resolve; });
  const cardSettingsStarted = new Promise<void>((resolve) => { migrationsStartedCardSettings = resolve; });
  const testApp = createTestApp(gate);
  const server = await startApp(testApp.app);
  try {
    const startup = runStartupInitialization(
      () => migrations,
      () => {
        migrationsStartedCardSettings();
        return cardSettings;
      },
      gate,
      () => assert.fail("successful initialization must not log a startup failure"),
    );

    const live = await request(server.port, "/api/livez");
    assert.equal(live.status, 200);
    assert.deepEqual(live.body, { status: "ok" });

    const pendingReadiness = await request(server.port, "/api/healthz");
    assert.equal(pendingReadiness.status, 503);
    assert.deepEqual(pendingReadiness.body, { status: "unavailable" });

    const pendingProduct = await request(server.port, "/api/product");
    assert.equal(pendingProduct.status, 503);
    assert.deepEqual(pendingProduct.body, { error: "Service is starting" });
    assert.equal(testApp.getDbProbes(), 0, "startup-incomplete readiness skips the database probe");
    assert.equal(testApp.getProductRequests(), 0, "product handlers are gated while startup is blocked");

    releaseMigrations();
    await cardSettingsStarted;
    const pendingCardInitialization = await request(server.port, "/api/healthz");
    assert.equal(pendingCardInitialization.status, 503);
    assert.equal(testApp.getDbProbes(), 0, "readiness waits for card-settings initialization too");

    releaseCardSettings();
    await startup;
    const readyHealth = await request(server.port, "/api/healthz");
    assert.equal(readyHealth.status, 200);
    assert.deepEqual(readyHealth.body, { status: "ok" });
    assert.equal(testApp.getDbProbes(), 1, "readiness probes only after startup completes");

    const readyProduct = await request(server.port, "/api/product");
    assert.equal(readyProduct.status, 200);
    assert.deepEqual(readyProduct.body, { ok: true });
    assert.equal(testApp.getProductRequests(), 1);
  } finally {
    await server.close();
  }
}

{
  const gate = createStartupReadiness();
  gate.markStarting();
  const testApp = createTestApp(gate);
  const server = await startApp(testApp.app);
  try {
    let cardSettingsCalled = false;
    let failureLogCount = 0;
    const startup = runStartupInitialization(
      async () => {
        throw new Error("sensitive database error detail");
      },
      async () => { cardSettingsCalled = true; },
      gate,
      () => { failureLogCount += 1; },
    );
    await startup;

    const live = await request(server.port, "/api/livez");
    assert.equal(live.status, 200);
    assert.deepEqual(live.body, { status: "ok" });

    const failedReadiness = await request(server.port, "/api/healthz");
    assert.equal(failedReadiness.status, 503);
    assert.deepEqual(failedReadiness.body, { status: "unavailable" });

    const failedProduct = await request(server.port, "/api/product");
    assert.equal(failedProduct.status, 503);
    assert.deepEqual(failedProduct.body, { error: "Service is unavailable" });
    assert.equal(JSON.stringify(failedReadiness.body).includes("sensitive"), false);
    assert.equal(testApp.getDbProbes(), 0, "failed startup never becomes a false-positive readiness");
    assert.equal(testApp.getProductRequests(), 0, "failed startup keeps product requests unavailable");
    assert.equal(cardSettingsCalled, false, "card initialization does not run after migration failure");
    assert.equal(failureLogCount, 1, "startup failure is logged exactly once through a sanitized callback");
  } finally {
    await server.close();
  }
}