import express, { type Express } from "express";
import cors from "cors";
import "./lib/poolMonitoring.js";
import router from "./routes";
import healthRouter from "./routes/health";
import { initializeCardSettingsStore } from "./lib/cardSettingsStore.js";
import { databaseSafeguardErrorHandler } from "./lib/databaseSafeguardErrorHandler.js";
import { startupReadiness } from "./lib/startupReadiness.js";
import { isServableCardAssetKey, streamCardAsset } from "./lib/cardAssetStorage.js";
import { join } from "path";
import { WORKSPACE_ROOT } from "./lib/workspaceRoot.js";

const app: Express = express();
// Requests arrive through Replit's edge proxy. Use the client address supplied
// by that single trusted hop for the login and admin rate limits.
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// Readiness and liveness must remain reachable while database-backed route
// initialization is blocked or the pool is saturated.
app.use("/api", healthRouter);

// Non-health API routes fail quickly until startup migrations and card settings
// have completed; they never wait behind startup database work.
app.use("/api", startupReadiness.middleware);

// Initialize/migrate once before any game or admin route reads the card settings.
let cardSettingsReady: Promise<void> | null = null;
app.use(async (_req, res, next) => {
  try {
    cardSettingsReady ??= initializeCardSettingsStore().catch(error => {
      cardSettingsReady = null;
      throw error;
    });
    await cardSettingsReady;
    next();
  } catch (error) {
    console.error("Card settings initialization failed:", error);
    res.status(503).json({ error: "Card settings are temporarily unavailable" });
  }
});

// Runtime uploads and migrated static assets are served from Object Storage;
// local static files remain as a non-destructive fallback during rollout.
app.use("/api/assets", async (req, res, next) => {
  if (req.method !== "GET") { next(); return; }
  const assetKey = req.path.replace(/^\/+/, "");
  if (!isServableCardAssetKey(assetKey)) {
    res.status(404).end();
    return;
  }
  try {
    if (assetKey && await streamCardAsset(assetKey, res)) return;
    next();
  } catch (error) {
    console.error("Object asset serving failed:", error);
    // Local build-time assets remain usable when Object Storage is temporarily
    // unavailable; do not turn a transient storage outage into an API failure.
    if (res.headersSent) res.destroy(error instanceof Error ? error : undefined);
    else next();
  }
});
app.use("/api/assets", express.static(join(WORKSPACE_ROOT, "artifacts/compost-heroes/public/assets")));

app.use("/api", router);

// Only known database contention/acquisition failures are converted to a
// sanitized retryable response. Unknown errors retain Express's normal error
// path; SQL text and driver details are never returned to API clients.
app.use(databaseSafeguardErrorHandler);

export default app;
