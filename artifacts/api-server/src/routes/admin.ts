import { Router, type Request, type Response, type NextFunction } from "express";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);
import { getAllCards } from "../lib/cards.js";
import { getAllOverrides, setImageKeyOverride, removeImageKeyOverride } from "../lib/imageKeyStore.js";
import { getAllCopies, getCardCopies, setCardCopies } from "../lib/cardCopiesStore.js";
import { WORKSPACE_ROOT } from "../lib/workspaceRoot.js";
import { pool } from "@workspace/db";
import { resetUserPassword } from "../lib/userStore.js";

// Resolve path to the frontend public/assets directory using workspace root
// Works correctly in both dev (tsx) and prod (bundled dist/index.cjs)
export const ASSETS_DIR = join(WORKSPACE_ROOT, "artifacts/compost-heroes/public/assets");

const router = Router();

// ── Admin auth middleware ──────────────────────────────────────────────────────

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const adminPassword = process.env.APP_PASSWORD;
  if (!adminPassword) {
    res.status(503).json({ error: "Admin access is not configured" });
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
    res.status(400).json({ error: "copies must be a non-negative integer" });
    return;
  }

  const cards = getAllCards();
  if (!cards.find((c) => c.id === cardId)) {
    res.status(404).json({ error: "Card not found" });
    return;
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
    res.status(400).json({ error: "Missing imageData, mimeType, or filename" });
    return;
  }

  const cards = getAllCards();
  if (!cards.find((c) => c.id === cardId)) {
    res.status(404).json({ error: "Card not found" });
    return;
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

// GET /api/admin/games — list all games with state summary
router.get("/admin/games", async (req, res) => {
  const phaseFilter = (req.query.phase as string | undefined) ?? "all";
  try {
    const whereClause = phaseFilter === "all"
      ? ""
      : phaseFilter === "active"
        ? `WHERE state->>'phase' NOT IN ('game_over','waiting') AND updated_at > NOW() - INTERVAL '3 hours'`
        : phaseFilter === "waiting"
          ? `WHERE state->>'phase' = 'waiting'`
          : phaseFilter === "finished"
            ? `WHERE state->>'phase' = 'game_over'`
            : "";

    const result = await pool.query<{
      game_id: string;
      phase: string;
      mode: string;
      player_count: string;
      player_names: string;
      updated_at: string;
      created_at: string;
      completed_at: string | null;
      has_password: string;
    }>(`
      SELECT
        game_id,
        state->>'phase' AS phase,
        state->>'mode' AS mode,
        jsonb_array_length(state->'players') AS player_count,
        (
          SELECT string_agg(p->>'name', ', ' ORDER BY ordinality)
          FROM jsonb_array_elements(state->'players') WITH ORDINALITY AS t(p, ordinality)
        ) AS player_names,
        updated_at,
        created_at,
        completed_at,
        CASE WHEN password IS NOT NULL THEN 'true' ELSE 'false' END AS has_password
      FROM compost_games
      ${whereClause}
      ORDER BY updated_at DESC
      LIMIT 200
    `);

    const phaseCounts = await pool.query<{ phase: string; count: string }>(`
      SELECT state->>'phase' AS phase, COUNT(*) AS count FROM compost_games GROUP BY phase
    `);

    const activeCount = await pool.query<{ count: string }>(`
      SELECT COUNT(*) AS count FROM compost_games
      WHERE state->>'phase' NOT IN ('game_over','waiting') AND updated_at > NOW() - INTERVAL '3 hours'
    `);

    res.json({
      games: result.rows.map(r => ({
        gameId: r.game_id,
        phase: r.phase,
        mode: r.mode,
        playerCount: parseInt(r.player_count, 10),
        playerNames: r.player_names ?? "",
        updatedAt: r.updated_at,
        createdAt: r.created_at,
        completedAt: r.completed_at,
        hasPassword: r.has_password === "true",
      })),
      phaseCounts: Object.fromEntries(phaseCounts.rows.map(r => [r.phase, parseInt(r.count, 10)])),
      activeCount: parseInt(activeCount.rows[0]?.count ?? "0", 10),
    });
  } catch (err) {
    console.error("[admin games]", err);
    res.status(500).json({ error: "Failed to fetch games" });
  }
});

// DELETE /api/admin/games/:gameId — delete a game record
router.delete("/admin/games/:gameId", async (req, res) => {
  const { gameId } = req.params as { gameId: string };
  try {
    await pool.query(`DELETE FROM compost_game_tokens WHERE game_id = $1`, [gameId]);
    const result = await pool.query(`DELETE FROM compost_games WHERE game_id = $1`, [gameId]);
    if ((result.rowCount ?? 0) === 0) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[admin delete game]", err);
    res.status(500).json({ error: "Failed to delete game" });
  }
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
          (SELECT COUNT(*) FROM compost_games WHERE state->>'phase' NOT IN ('game_over','waiting') AND updated_at > NOW() - INTERVAL '3 hours') AS active_games,
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
       `SELECT u.id, u.email, u.name, u.organization,
               CASE WHEN u.role = 'facilitator' AND u.role_approved_at IS NOT NULL
                    THEN 'facilitator' ELSE NULL END AS role, u.created_at,
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

// Admin-only facilitator approval. Existing self-supplied role strings lack
// role_approved_at and never grant access until explicitly approved here.
router.patch("/admin/users/:userId/facilitator", async (req: Request, res: Response) => {
  const userId = String(req.params.userId);
  const approved = (req.body as { approved?: unknown })?.approved;
  if (typeof approved !== "boolean") {
    res.status(400).json({ error: "approved must be a boolean" });
    return;
  }
  try {
    const result = await pool.query<{ role: string | null }>(
      `UPDATE compost_users
       SET role = $2, role_approved_at = CASE WHEN $3::boolean THEN NOW() ELSE NULL END
       WHERE id = $1 RETURNING role`,
      [userId, approved ? "facilitator" : null, approved]
    );
    if (!result.rowCount) { res.status(404).json({ error: "User not found" }); return; }
    res.json({ role: result.rows[0].role });
  } catch (err) {
    console.error("[admin facilitator approval]", err);
    res.status(500).json({ error: "Could not update facilitator access" });
  }
});

// Remove the account and its sign-in sessions (cascading FK). Game state and
// analytics are intentionally retained so existing sessions/history survive.
router.delete("/admin/users/:userId", async (req: Request, res: Response) => {
  const userId = String(req.params.userId);
  try {
    const result = await pool.query(
      `DELETE FROM compost_users WHERE id = $1 RETURNING id`,
      [userId]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.sendStatus(204);
  } catch (err) {
    console.error("[admin delete user]", err);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// ── User password reset ───────────────────────────────────────────────────────

router.patch("/admin/users/:userId/reset-password", requireAdmin, async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { newPassword } = req.body as { newPassword?: string };
  if (!newPassword || newPassword.length < 6) {
    res.status(400).json({ error: "New password must be at least 6 characters" });
    return;
  }
  try {
    await resetUserPassword(String(userId), newPassword);
    res.json({ success: true });
  } catch (err: any) {
    if (err?.code === "USER_NOT_FOUND") {
      res.status(404).json({ error: "User not found" });
    } else {
      console.error("[admin reset-password]", err);
      res.status(500).json({ error: "Failed to reset password" });
    }
  }
});

// ── Backup: database ──────────────────────────────────────────────────────────

// GET /api/admin/backup/db — stream a pg_dump SQL file to the client
router.get("/admin/backup/db", async (req, res) => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    res.status(500).json({ error: "DATABASE_URL not configured" });
    return;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `compost-heroes-db-${ts}.sql`;
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const child = spawn("pg_dump", ["--no-password", dbUrl], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(res);
  child.stderr.on("data", (d: Buffer) => console.error("[backup/db]", d.toString()));
  child.on("error", (err) => {
    console.error("[backup/db] spawn error", err);
    if (!res.headersSent) res.status(500).end("pg_dump failed");
  });
  child.on("close", (code) => {
    if (code !== 0) console.error(`[backup/db] pg_dump exited with code ${code}`);
  });
});

// ── Backup: GitHub ────────────────────────────────────────────────────────────

// GET /api/admin/backup/github/status — check configuration & last commit
router.get("/admin/backup/github/status", async (req, res) => {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_BACKUP_REPO;
  const configured = !!(token && repo);

  let lastCommit: string | null = null;
  let remoteUrl: string | null = null;
  try {
    const { stdout: log } = await execFileAsync("git", ["log", "-1", "--format=%h %s (%cr)", "--"], { timeout: 5000 });
    lastCommit = log.trim() || null;
  } catch { /* no commits yet */ }

  try {
    const { stdout: remote } = await execFileAsync("git", ["remote", "get-url", "github-backup"], { timeout: 3000 });
    remoteUrl = remote.trim().replace(/:[^@]+@/, ":***@") || null; // redact token
  } catch { /* remote not set up yet */ }

  res.json({ configured, repo: repo ?? null, remoteUrl, lastCommit });
});

// POST /api/admin/backup/github/push — commit everything and push to GitHub
router.post("/admin/backup/github/push", async (req, res) => {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_BACKUP_REPO;

  if (!token || !repo) {
    res.status(400).json({ error: "GITHUB_TOKEN secret and GITHUB_BACKUP_REPO env var must both be set." });
    return;
  }

  const remoteUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");

  try {
    // Ensure the remote exists (update it if already present)
    try {
      await execFileAsync("git", ["remote", "remove", "github-backup"], { timeout: 3000 });
    } catch { /* didn't exist, that's fine */ }
    await execFileAsync("git", ["remote", "add", "github-backup", remoteUrl], { timeout: 3000 });

    // Configure git identity for the commit
    await execFileAsync("git", ["config", "user.email", "backup@compostheroes.app"], { timeout: 3000 });
    await execFileAsync("git", ["config", "user.name", "Compost Heroes Backup"], { timeout: 3000 });

    // Stage everything and create a backup commit
    await execFileAsync("git", ["add", "-A"], { timeout: 10000 });

    // Commit — don't fail if nothing to commit
    try {
      await execFileAsync("git", ["commit", "-m", `backup: ${ts}`], { timeout: 10000 });
    } catch (e: any) {
      if (!String(e?.stderr ?? e?.message ?? "").includes("nothing to commit")) throw e;
    }

    // Push (force to keep the backup branch tidy)
    await execFileAsync("git", ["push", "github-backup", "HEAD:main", "--force"], { timeout: 60000 });

    res.json({ success: true, pushedAt: new Date().toISOString(), repo });
  } catch (err: any) {
    const msg = String(err?.stderr ?? err?.message ?? err);
    console.error("[backup/github]", msg);
    res.status(500).json({ error: msg.replace(token, "***") }); // redact token from error
  }
});

export default router;
