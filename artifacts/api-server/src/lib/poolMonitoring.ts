import { pool } from "@workspace/db";
import {
  instrumentPoolAcquisitions,
  RecentPoolAcquisitionMetrics,
  type PoolConnectInstrumentable,
} from "./databaseSafeguards.js";

export const poolAcquisitionMetrics = new RecentPoolAcquisitionMetrics();

// Install before importing API route modules so direct connect() calls and the
// connections acquired internally by pool.query() are all timed.
instrumentPoolAcquisitions(
  pool as unknown as PoolConnectInstrumentable,
  poolAcquisitionMetrics,
);

// pg-pool emits idle-client errors on this event. Keep a listener installed so
// these errors are logged structurally rather than becoming unhandled events;
// do not log query text, error messages, connection strings, or client details.
pool.on("error", (error: Error) => {
  const code = (error as Error & { code?: unknown }).code;
  console.error(JSON.stringify({
    level: "error",
    event: "postgres_idle_pool_client_error",
    errorName: error.name,
    errorCode: typeof code === "string" ? code : undefined,
  }));
});