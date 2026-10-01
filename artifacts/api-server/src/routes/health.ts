import { Router, type IRouter } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  AdminHealthCheckQueryParams,
  AdminHealthCheckResponse,
  HealthCheckResponse,
  LivenessCheckResponse,
} from "@workspace/api-zod";
import { pool } from "@workspace/db";
import {
  DATABASE_READINESS_TIMEOUT_MS,
  isDatabaseReady,
  type ReadinessPool,
} from "../lib/healthReadiness.js";
import { getAdminPoolDiagnostics } from "../lib/databaseSafeguards.js";
import { poolAcquisitionMetrics } from "../lib/poolMonitoring.js";
import { startupReadiness } from "../lib/startupReadiness.js";

function hasValidAdminKey(supplied: string, expected: string): boolean {
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

export function createHealthRouter(
  readinessPool: ReadinessPool,
  getAdminPassword: () => string | undefined = () => process.env.APP_PASSWORD,
  readinessTimeoutMs = DATABASE_READINESS_TIMEOUT_MS,
  isStartupReady: () => boolean = startupReadiness.isReady,
): IRouter {
  const router: IRouter = Router();

  router.get("/livez", (_req, res) => {
    const data = LivenessCheckResponse.parse({ status: "ok" });
    res.json(data);
  });

  router.get("/healthz", async (_req, res) => {
    const ready = isStartupReady() &&
      await isDatabaseReady(readinessPool, readinessTimeoutMs);
    const data = HealthCheckResponse.parse({ status: ready ? "ok" : "unavailable" });
    res.status(ready ? 200 : 503).json(data);
  });

  router.get("/admin/healthz", async (req, res) => {
    const adminPassword = getAdminPassword();
    if (!adminPassword) {
      res.status(503).json({ error: "Admin access is not configured" });
      return;
    }

    const header = req.headers["x-admin-key"];
    const supplied = typeof header === "string" ? header : "";
    if (!hasValidAdminKey(supplied, adminPassword)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsedQuery = AdminHealthCheckQueryParams.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: "sinceMs must be a non-negative number" });
      return;
    }

    const ready = isStartupReady() &&
      await isDatabaseReady(readinessPool, readinessTimeoutMs);
    const diagnostics = getAdminPoolDiagnostics(
      readinessPool,
      poolAcquisitionMetrics,
      parsedQuery.data.sinceMs,
    );
    const data = AdminHealthCheckResponse.parse({
      status: ready ? "ok" : "unavailable",
      pool: diagnostics,
    });
    res.status(ready ? 200 : 503).json(data);
  });

  return router;
}

export default createHealthRouter(pool);
