import assert from "node:assert/strict";
import type { Request, Response, NextFunction } from "express";
import { createAuthRateLimiter } from "../lib/authRateLimit.js";

function requestFor(ip: string): Request {
  return { ip, socket: { remoteAddress: ip } } as unknown as Request;
}

function invokeLimiter(
  middleware: ReturnType<typeof createAuthRateLimiter>,
  ip: string,
): { statusCode: number; body?: unknown; retryAfter?: string; continued: boolean } {
  const result: {
    statusCode: number;
    body?: unknown;
    retryAfter?: string;
    continued: boolean;
  } = { statusCode: 200, continued: false };
  const response = {
    set(name: string, value: string) {
      if (name === "Retry-After") result.retryAfter = value;
      return this;
    },
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
  } as unknown as Response;

  middleware(requestFor(ip), response, (() => {
    result.continued = true;
  }) as NextFunction);
  return result;
}

let now = 10_000;
const loginLimiter = createAuthRateLimiter(2, 1_000, () => now);
const registerLimiter = createAuthRateLimiter(1, 5_000, () => now);

assert.equal(invokeLimiter(loginLimiter, "192.0.2.1").statusCode, 200);
assert.equal(invokeLimiter(loginLimiter, "192.0.2.1").statusCode, 200);
const blockedLogin = invokeLimiter(loginLimiter, "192.0.2.1");
assert.equal(blockedLogin.statusCode, 429);
assert.equal(blockedLogin.continued, false);
assert.equal(blockedLogin.retryAfter, "1");

// Buckets are scoped per client IP and independent across auth operations.
assert.equal(invokeLimiter(loginLimiter, "192.0.2.2").statusCode, 200);
assert.equal(invokeLimiter(registerLimiter, "192.0.2.1").statusCode, 200);
assert.equal(invokeLimiter(registerLimiter, "192.0.2.1").statusCode, 429);

now += 1_001;
assert.equal(invokeLimiter(loginLimiter, "192.0.2.1").statusCode, 200);
console.log("Auth rate-limit tests passed");