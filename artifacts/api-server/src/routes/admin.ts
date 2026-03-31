import { Router, type Request, type Response, type NextFunction } from "express";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getAllCards } from "../lib/cards.js";
import { getAllOverrides, setImageKeyOverride, removeImageKeyOverride } from "../lib/imageKeyStore.js";
import { getAllCopies, getCardCopies, setCardCopies } from "../lib/cardCopiesStore.js";
import { WORKSPACE_ROOT } from "../lib/workspaceRoot.js";
import { pool } from "@workspace/db";

// Resolve path to the frontend public/assets directory using workspace root
// Works correctly in both dev (tsx) and prod (bundled dist/index.cjs)
export const ASSETS_DIR = join(WORKSPACE_ROOT, "artifacts/compost-heroes/public/assets");

const router = Router();

// ── Admin auth middleware ──────────────────────────────────────────────────────

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const adminPassword = process.env.APP_PASSWORD;
  if (!adminPassword) {
    // No password configured — open access (dev fallback)
    next();
    return;
  }
  const supplied =
    (req.headers["x-admin-key"] as string | undefined) ??
    (req.query.adminKey as string | undefined);
  if (!supplied || supplied !== adminPassword) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

router.use("/admin", requireAdmin);

// GET /api/admin/cards — list all cards with current image keys and copy counts
router.get("/admin/cards", (_req, res) => {
  const cards = getAllCards();
  const imageOverrides = getAllOverrides();
  const copiesMap = getAllCopies();
  const result = cards.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    function: c.function,
    imageKey: imageOverrides[c.id] ?? c.imageKey,
    hasHardcodedImage: !!c.imageKey,
    hasOverrideImage: !!imageOverrides[c.id],
    copies: copiesMap[c.id] ?? 1,
  }));
  res.json(result);
});

// PUT /api/admin/cards/:cardId/copies — set the number of copies in the deck
router.put("/admin/cards/:cardId/copies", (req, res) => {
  const { cardId } = req.params;
  const { copies } = req.body as { copies: number };

  if (typeof copies !== "number" || !Number.isInteger(copies) || copies < 0) {
    return res.status(400).json({ error: "copies must be a non-negative integer" });
  }

  const cards = getAllCards();
  if (!cards.find((c) => c.id === cardId)) {
    return res.status(404).json({ error: "Card not found" });
  }

  setCardCopies(cardId, copies);
  res.json({ success: true, cardId, copies });
});

// POST /api/admin/cards/:cardId/image — upload image as base64
router.post("/admin/cards/:cardId/image", (req, res) => {
  const { cardId } = req.params;
  const { imageData, mimeType, filename } = req.body as {
    imageData: string;
    mimeType: string;
    filename: string;
  };

  if (!imageData || !mimeType || !filename) {
    return res.status(400).json({ error: "Missing imageData, mimeType, or filename" });
  }

  const cards = getAllCards();
  if (!cards.find((c) => c.id === cardId)) {
    return res.status(404).json({ error: "Card not found" });
  }

  try {
    if (!existsSync(ASSETS_DIR)) {
      mkdirSync(ASSETS_DIR, { recursive: true });
    }

    const ext = filename.split(".").pop()?.toLowerCase() || "jpg";
    const safeCardId = cardId.replace(/[^a-z0-9_]/gi, "_");
    const imageKey = `${safeCardId}_${Date.now()}.${ext}`;
    const destPath = join(ASSETS_DIR, imageKey);

    const buffer = Buffer.from(imageData, "base64");
    writeFileSync(destPath, buffer);

    setImageKeyOverride(cardId, imageKey);

    res.json({ success: true, imageKey });
  } catch (err) {
    console.error("Image upload error:", err);
    res.status(500).json({ error: "Failed to save image" });
  }
});

// DELETE /api/admin/cards/:cardId/image — remove override image assignment
router.delete("/admin/cards/:cardId/image", (req, res) => {
  const { cardId } = req.params;
  removeImageKeyOverride(cardId);
  res.json({ success: true });
});

// GET /api/admin/analytics — player behavior summary
router.get("/admin/analytics", async (_req, res) => {
  try {
    const [
      summary,
      registrationsOverTime,
      loginsOverTime,
      eventsByType,
      gamesByMode,
      gamesByPlayerCount,
      recentEvents,
      topUsersByLogins,
    ] = await Promise.all([
      // Summary counts
      pool.query<{
        total_users: string;
        total_logins: string;
        total_games: string;
        completed_games: string;
        active_games: string;
        online_games: string;
      }>(`
        SELECT
          (SELECT COUNT(*) FROM compost_users) AS total_users,
          (SELECT COUNT(*) FROM compost_analytics_events WHERE event_type = 'login') AS total_logins,
          (SELECT COUNT(*) FROM compost_analytics_events WHERE event_type = 'game_created') AS total_games,
          (SELECT COUNT(*) FROM compost_analytics_events WHERE event_type = 'game_completed') AS completed_games,
          (SELECT COUNT(*) FROM compost_games WHERE state->>'phase' NOT IN ('game_over','waiting')) AS active_games,
          (SELECT COUNT(*) FROM compost_analytics_events WHERE event_type = 'game_created' AND metadata::jsonb->>'mode' = 'online') AS online_games
      `),

      // Registrations last 30 days
      pool.query<{ date: string; count: string }>(`
        SELECT DATE(created_at) AS date, COUNT(*) AS count
        FROM compost_analytics_events
        WHERE event_type = 'register' AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at) ORDER BY date
      `),

      // Logins last 30 days
      pool.query<{ date: string; count: string }>(`
        SELECT DATE(created_at) AS date, COUNT(*) AS count
        FROM compost_analytics_events
        WHERE event_type = 'login' AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at) ORDER BY date
      `),

      // Events by type (last 30 days)
      pool.query<{ event_type: string; count: string }>(`
        SELECT event_type, COUNT(*) AS count
        FROM compost_analytics_events
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY event_type ORDER BY count DESC
      `),

      // Games by mode
      pool.query<{ mode: string; count: string }>(`
        SELECT metadata::jsonb->>'mode' AS mode, COUNT(*) AS count
        FROM compost_analytics_events
        WHERE event_type = 'game_created'
        GROUP BY mode ORDER BY count DESC
      `),

      // Games by player count
      pool.query<{ player_count: string; count: string }>(`
        SELECT int_value AS player_count, COUNT(*) AS count
        FROM compost_analytics_events
        WHERE event_type = 'game_created' AND int_value IS NOT NULL
        GROUP BY int_value ORDER BY int_value
      `),

      // Recent activity (last 50 events)
      pool.query<{ event_type: string; game_id: string | null; user_id: string | null; metadata: string | null; created_at: string; user_name: string | null }>(`
        SELECT e.event_type, e.game_id, e.user_id, e.metadata, e.created_at, u.name AS user_name
        FROM compost_analytics_events e
        LEFT JOIN compost_users u ON u.id = e.user_id
        ORDER BY e.created_at DESC LIMIT 50
      `),

      // Top users by login count
      pool.query<{ user_id: string; name: string; email: string; login_count: string; games_created: string; last_login: string }>(`
        SELECT
          u.id AS user_id, u.name, u.email,
          COUNT(CASE WHEN e.event_type = 'login' THEN 1 END) AS login_count,
          COUNT(CASE WHEN e.event_type = 'game_created' THEN 1 END) AS games_created,
          MAX(CASE WHEN e.event_type = 'login' THEN e.created_at END) AS last_login
        FROM compost_users u
        LEFT JOIN compost_analytics_events e ON e.user_id = u.id
        GROUP BY u.id, u.name, u.email
        ORDER BY login_count DESC
        LIMIT 20
      `),
    ]);

    const s = summary.rows[0];
    res.json({
      summary: {
        totalUsers: parseInt(s.total_users, 10),
        totalLogins: parseInt(s.total_logins, 10),
        totalGames: parseInt(s.total_games, 10),
        completedGames: parseInt(s.completed_games, 10),
        activeGames: parseInt(s.active_games, 10),
        onlineGames: parseInt(s.online_games, 10),
      },
      registrationsOverTime: registrationsOverTime.rows.map(r => ({ date: r.date, count: parseInt(r.count, 10) })),
      loginsOverTime: loginsOverTime.rows.map(r => ({ date: r.date, count: parseInt(r.count, 10) })),
      eventsByType: eventsByType.rows.map(r => ({ eventType: r.event_type, count: parseInt(r.count, 10) })),
      gamesByMode: gamesByMode.rows.map(r => ({ mode: r.mode ?? "unknown", count: parseInt(r.count, 10) })),
      gamesByPlayerCount: gamesByPlayerCount.rows.map(r => ({ playerCount: parseInt(r.player_count, 10), count: parseInt(r.count, 10) })),
      recentEvents: recentEvents.rows.map(r => ({
        eventType: r.event_type,
        gameId: r.game_id,
        userId: r.user_id,
        userName: r.user_name,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
        createdAt: r.created_at,
      })),
      topUsers: topUsersByLogins.rows.map(r => ({
        userId: r.user_id,
        name: r.name,
        email: r.email,
        loginCount: parseInt(r.login_count, 10),
        gamesCreated: parseInt(r.games_created, 10),
        lastLogin: r.last_login,
      })),
    });
  } catch (err) {
    console.error("[admin analytics]", err);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

// GET /api/admin/users — list all registered users with stats
router.get("/admin/users", async (_req, res) => {
  try {
    const result = await pool.query<{
      id: string;
      email: string;
      name: string;
      organization: string | null;
      role: string | null;
      created_at: string;
      session_count: string;
    }>(
      `SELECT u.id, u.email, u.name, u.organization, u.role, u.created_at,
              COUNT(s.token) AS session_count
       FROM compost_users u
       LEFT JOIN compost_user_sessions s ON s.user_id = u.id
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    );
    res.json(
      result.rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        organization: r.organization,
        role: r.role,
        createdAt: r.created_at,
        sessionCount: parseInt(r.session_count, 10),
      }))
    );
  } catch (err) {
    console.error("[admin users]", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

export default router;
