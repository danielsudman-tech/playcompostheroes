import { Router, type IRouter } from "express";

const router: IRouter = Router();

const APP_PASSWORD = process.env["APP_PASSWORD"];

router.get("/auth/config", (_req, res) => {
  res.json({ requiresPassword: !!APP_PASSWORD });
});

router.post("/auth/verify", (req, res) => {
  const { password } = req.body as { password?: string };

  if (!APP_PASSWORD) {
    res.json({ ok: true });
    return;
  }

  if (!password || password !== APP_PASSWORD) {
    res.status(401).json({ ok: false, error: "Incorrect password" });
    return;
  }

  res.json({ ok: true });
});

export default router;
