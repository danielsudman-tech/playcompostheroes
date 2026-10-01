import app from "./app";
import { runStartupMigrations } from "./lib/analyticsStore.js";
import { initializeCardSettingsStore } from "./lib/cardSettingsStore.js";
import { runStartupInitialization, startupReadiness } from "./lib/startupReadiness.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

startupReadiness.markStarting();
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  void runStartupInitialization(
    runStartupMigrations,
    initializeCardSettingsStore,
    startupReadiness,
    () => console.error("[startup] API initialization failed; service remains unavailable"),
  );
});
