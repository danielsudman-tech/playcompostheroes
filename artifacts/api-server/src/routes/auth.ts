import { Router, type IRouter } from "express";
import { registerUser, loginUser, getUserByToken } from "../lib/userStore.js";

const router: IRouter = Router();

router.get("/auth/config", (_req, res) => {
  res.json({ requiresRegistration: true });
});

router.post("/auth/register", async (req, res) => {
  const { email, name, password, organization, role } = req.body as {
    email?: string;
    name?: string;
    password?: string;
    organization?: string;
    role?: string;
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
    const result = await registerUser(email, name, password, organization, role);
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

router.post("/auth/login", async (req, res) => {
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
  const token = req.query.token as string | undefined;
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
