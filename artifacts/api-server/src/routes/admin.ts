import { Router } from "express";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getAllCards } from "../lib/cards.js";
import { getAllOverrides, setImageKeyOverride, removeImageKeyOverride } from "../lib/imageKeyStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve path to the frontend public/assets directory
const ASSETS_DIR = join(__dirname, "../../../compost-heroes/public/assets");

const router = Router();

// GET /api/admin/cards — list all cards with current image keys
router.get("/admin/cards", (_req, res) => {
  const cards = getAllCards();
  const overrides = getAllOverrides();
  const result = cards.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    function: c.function,
    imageKey: overrides[c.id] ?? c.imageKey,
    hasHardcodedImage: !!c.imageKey,
    hasOverrideImage: !!overrides[c.id],
  }));
  res.json(result);
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

export default router;
