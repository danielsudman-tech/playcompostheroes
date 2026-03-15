import { Router, type IRouter } from "express";
import { registerOrLoginUser, getUserByToken } from "../lib/userStore.js";

const router: IRouter = Router();

router.get("/auth/config", (_req, res) => {
  res.json({ requiresRegistration: true });
});

router.post("/auth/register", async (req, res) => {
  const { email, name, organization, role } = req.body as {
    email?: string;
    name?: string;
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

  try {
    const result = await registerOrLoginUser(email, name, organization, role);
    res.json({ token: result.token, user: result.user, isNew: result.isNew });
  } catch (err) {
    console.error("[auth register]", err);
    res.status(500).json({ error: "Registration failed, please try again" });
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
