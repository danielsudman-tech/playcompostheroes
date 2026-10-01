import type { NextFunction, Request, Response } from "express";

export type StartupState = "starting" | "ready" | "failed";

export interface StartupReadiness {
  getState(): StartupState;
  isReady(): boolean;
  markStarting(): void;
  markReady(): void;
  markFailed(): void;
  middleware(req: Request, res: Response, next: NextFunction): void;
}

export function createStartupReadiness(initialState: StartupState = "starting"): StartupReadiness {
  let state = initialState;

  return {
    getState: () => state,
    isReady: () => state === "ready",
    markStarting() {
      state = "starting";
    },
    markReady() {
      if (state === "starting") state = "ready";
    },
    markFailed() {
      state = "failed";
    },
    middleware(_req, res, next) {
      if (state === "ready") {
        next();
        return;
      }
      res.status(503).json({
        error: state === "failed" ? "Service is unavailable" : "Service is starting",
      });
    },
  };
}

export async function runStartupInitialization(
  runMigrations: () => Promise<void>,
  initializeCardSettings: () => Promise<void>,
  readiness: StartupReadiness,
  onFailure: () => void,
): Promise<void> {
  try {
    await runMigrations();
    await initializeCardSettings();
    readiness.markReady();
  } catch {
    readiness.markFailed();
    onFailure();
  }
}

// Direct app imports used by route tests remain usable; the production entry
// point closes the gate before opening its listener.
export const startupReadiness = createStartupReadiness("ready");