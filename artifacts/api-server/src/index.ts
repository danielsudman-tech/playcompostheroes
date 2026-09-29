import app from "./app";
import { runStartupMigrations } from "./lib/analyticsStore.js";

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

runStartupMigrations()
  .then(() => app.listen(port, () => console.log(`Server listening on port ${port}`)))
  .catch(err => { console.error("[startup migrations]", err); process.exitCode = 1; });
