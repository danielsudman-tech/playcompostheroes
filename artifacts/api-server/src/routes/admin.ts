import { Router } from "express";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getAllCards } from "../lib/cards.js";
import { getAllOverrides, setImageKeyOverride, removeImageKeyOverride } from "../lib/imageKeyStore.js";
import { getAllCopies, getCardCopies, setCardCopies } from "../lib/cardCopiesStore.js";
import { WORKSPACE_ROOT } from "../lib/workspaceRoot.js";

// Resolve path to the frontend public/assets directory using workspace root
// Works correctly in both dev (tsx) and prod (bundled dist/index.cjs)
export const ASSETS_DIR = join(WORKSPACE_ROOT, "artifacts/compost-heroes/public/assets");

const router = Router();

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

export default router;
