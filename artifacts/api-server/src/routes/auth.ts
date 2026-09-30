import { Router, type IRouter } from "express";
import { registerUser, loginUser, getUserByToken } from "../lib/userStore.js";
import { logEvent } from "../lib/analyticsStore.js";
import { createAuthRateLimiter } from "../lib/authRateLimit.js";

const router: IRouter = Router();
const registerRateLimit = createAuthRateLimiter(5, 60 * 60 * 1000);
const loginRateLimit = createAuthRateLimiter(10, 15 * 60 * 1000);

router.get("/auth/config", (_req, res) => {
  res.json({ requiresRegistration: true });
});

router.post("/auth/register", registerRateLimit, async (req, res) => {
  const { email, name, password, organization } = req.body as {
    email?: string;
    name?: string;
    password?: string;
    organization?: string;
  };

  if (!email?.trim() || !name?.trim()) {
    res.status(400).json({ error: "Name and email are required" });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    res.status(400).json({ error: "Please enter a valid email address" });
    return;
  }
  if (!password || password.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }

  try {
    const result = await registerUser(email, name, password, organization);
    logEvent("register", { userId: result.user.id, metadata: { organization: organization ?? null } });
    res.json({ token: result.token, user: result.user });
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === "EMAIL_EXISTS") {
      res.status(409).json({ error: e.message });
    } else {
      console.error("[auth register]", err);
      res.status(500).json({ error: "Registration failed, please try again" });
    }
  }
});

router.post("/auth/login", loginRateLimit, async (req, res) => {
  const { email, password } = req.body as {
    email?: string;
    password?: string;
  };

  if (!email?.trim() || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  try {
    const result = await loginUser(email, password);
    logEvent("login", { userId: result.user.id });
    res.json({ token: result.token, user: result.user });
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === "USER_NOT_FOUND" || e.code === "WRONG_PASSWORD" || e.code === "NO_PASSWORD") {
      res.status(401).json({ error: e.message });
    } else {
      console.error("[auth login]", err);
      res.status(500).json({ error: "Login failed, please try again" });
    }
  }
});

router.get("/auth/me", async (req, res) => {
  const authorization = req.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  if (!token) {
    res.status(401).json({ error: "No token provided" });
    return;
  }
  try {
    const user = await getUserByToken(token);
    if (!user) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }
    res.json({ user });
  } catch (err) {
    console.error("[auth me]", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/auth/verify", (_req, res) => {
  res.json({ ok: true });
});

export default router;
