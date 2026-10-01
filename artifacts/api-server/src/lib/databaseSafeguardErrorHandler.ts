import type { ErrorRequestHandler } from "express";
import {
  classifyDatabaseSafeguardError,
  DatabaseSafeguardError,
} from "./databaseSafeguards.js";

export const databaseSafeguardErrorHandler: ErrorRequestHandler = (
  error,
  _req,
  res,
  next,
) => {
  if (!classifyDatabaseSafeguardError(error)) {
    next(error);
    return;
  }
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : undefined);
    return;
  }
  res.status(503).json(error instanceof DatabaseSafeguardError
    ? error.toSafeResponse()
    : { error: "Database temporarily unavailable" });
};