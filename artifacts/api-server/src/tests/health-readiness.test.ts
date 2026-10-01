import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import express from "express";
import {
  isDatabaseReady,
  type ReadinessClient,
  type ReadinessPool,
} from "../lib/healthReadiness.js";

function makePool(connect: () => Promise<ReadinessClient>): ReadinessPool {
  return {
    connect,
    totalCount: 16,
    idleCount: 8,
    waitingCount: 0,
  };
}

const healthyClient = (release: (error?: Error | boolean) => void = () => undefined): ReadinessClient => ({
  query: async (sql) => {
    assert.equal(sql, "SELECT 1");
    return { rows: [{ "?column?": 1 }] };
  },
  release,
});

assert.equal(await isDatabaseReady(makePool(async () => healthyClient()), 100), true);

let resolveLateAcquisition!: (client: ReadinessClient) => void;
let lateAcquisitionRelease: Error | boolean | undefined;
const saturatedPool = makePool(() => new Promise((resolve) => {
  resolveLateAcquisition = resolve;
}));
assert.equal(await isDatabaseReady(saturatedPool, 15), false);
resolveLateAcquisition(healthyClient((error) => {
  lateAcquisitionRelease = error;
}));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(lateAcquisitionRelease instanceof Error, "late-acquired client is discarded");

let queryDestroyError: Error | boolean | undefined;
const hungQueryClient: ReadinessClient = {
  query: () => new Promise(() => undefined),
  release: (error) => {
    queryDestroyError = error;
  },
};
assert.equal(await isDatabaseReady(makePool(async () => hungQueryClient), 15), false);
assert.ok(queryDestroyError instanceof Error, "active-query client is destroyed on timeout");

let recover = false;
const recoveringPool = makePool(async () => {
  if (!recover) {
    return {
      query: () => new Promise(() => undefined),
      release: () => undefined,
    };
  }
  return healthyClient();
});
assert.equal(await isDatabaseReady(recoveringPool, 15), false);
recover = true;
assert.equal(await isDatabaseReady(recoveringPool, 100), true);

process.env.DATABASE_URL ??= "postgres://health-test:health-test@127.0.0.1:1/health";
const { createHealthRouter } = await import("../routes/health.js");
let connectionAttempts = 0;
let routePoolReady = true;
const routePool = makePool(async () => {
  connectionAttempts += 1;
  if (!routePoolReady) {
    return {
      query: () => new Promise(() => undefined),
      release: () => undefined,
    };
  }
  return healthyClient();
});
const app = express();
app.use("/api", createHealthRouter(routePool, () => "test-admin-key", 15, () => true));
const server = createServer(app);
server.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const requestAt = (port: number, path: string, adminKey?: string) => new Promise<{
  status: number;
  body: unknown;
}>((resolve, reject) => {
  const req = get({
    host: "127.0.0.1",
    port,
    path,
    headers: adminKey ? { "x-admin-key": adminKey } : {},
  }, (res) => {
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
  req.setTimeout(2_500, () => req.destroy(new Error("HTTP health request timed out")));
});
const request = (path: string, adminKey?: string) =>
  requestAt(address.port, path, adminKey);

try {
  const publicResponse = await request("/api/healthz");
  assert.equal(publicResponse.status, 200);
  assert.deepEqual(publicResponse.body, { status: "ok" });

  const unauthorizedResponse = await request("/api/admin/healthz", "wrong-key");
  assert.equal(unauthorizedResponse.status, 401);
  assert.deepEqual(unauthorizedResponse.body, { error: "Unauthorized" });
  assert.equal(connectionAttempts, 1, "unauthorized requests do not probe the pool");

  const adminResponse = await request("/api/admin/healthz", "test-admin-key");
  assert.equal(adminResponse.status, 200);
  assert.deepEqual(adminResponse.body, {
    status: "ok",
    pool: {
      total: 16,
      idle: 8,
      waiting: 0,
      acquisitionWait: { count: 0, maxMs: 0, p95Ms: 0 },
    },
  });
  const filteredAdminResponse = await request("/api/admin/healthz?sinceMs=10000", "test-admin-key");
  assert.equal(filteredAdminResponse.status, 200);
  assert.deepEqual(
    (filteredAdminResponse.body as { pool: { acquisitionWait: unknown } }).pool.acquisitionWait,
    { count: 0, maxMs: 0, p95Ms: 0 },
    "admin acquisition diagnostics accept an optional sinceMs window",
  );
  const invalidWindowResponse = await request("/api/admin/healthz?sinceMs=-1", "test-admin-key");
  assert.equal(invalidWindowResponse.status, 400, "invalid diagnostic windows are rejected");
  assert.deepEqual(invalidWindowResponse.body, { error: "sinceMs must be a non-negative number" });

  routePoolReady = false;
  const unavailableResponse = await request("/api/healthz");
  assert.equal(unavailableResponse.status, 503);
  assert.deepEqual(unavailableResponse.body, { status: "unavailable" });

  const livenessResponse = await request("/api/livez");
  assert.equal(livenessResponse.status, 200);
  assert.deepEqual(livenessResponse.body, { status: "ok" });
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

const [{ default: productionApp }, { pool: dbPool }] = await Promise.all([
  import("../app.js"),
  import("@workspace/db"),
]);
const originalQuery = dbPool.query;
const originalConnect = dbPool.connect;
let initializationQueryCount = 0;
let productionConnectCount = 0;
dbPool.query = (() => {
  initializationQueryCount += 1;
  return new Promise(() => undefined);
}) as typeof dbPool.query;
dbPool.connect = (() => {
  productionConnectCount += 1;
  return new Promise(() => undefined);
}) as typeof dbPool.connect;

const productionServer = createServer(productionApp);
productionServer.listen(0);
await new Promise<void>((resolve) => productionServer.once("listening", resolve));
const productionAddress = productionServer.address();
assert.ok(productionAddress && typeof productionAddress !== "string");
try {
  const livezResponse = await requestAt(productionAddress.port, "/api/livez");
  assert.equal(livezResponse.status, 200);
  assert.deepEqual(livezResponse.body, { status: "ok" });
  assert.equal(initializationQueryCount, 0, "cold-start liveness skips DB initialization");
  assert.equal(productionConnectCount, 0, "cold-start liveness does not acquire a DB client");

  const startedAt = Date.now();
  const readinessResponse = await requestAt(productionAddress.port, "/api/healthz");
  assert.equal(readinessResponse.status, 503);
  assert.deepEqual(readinessResponse.body, { status: "unavailable" });
  assert.ok(Date.now() - startedAt < 2_500, "cold-start readiness remains bounded");
  assert.equal(initializationQueryCount, 0, "readiness does not enter DB-dependent initialization");
  assert.equal(productionConnectCount, 1, "cold-start readiness performs its bounded probe");
} finally {
  dbPool.query = originalQuery;
  dbPool.connect = originalConnect;
  await new Promise<void>((resolve, reject) => {
    productionServer.close((error) => error ? reject(error) : resolve());
  });
}