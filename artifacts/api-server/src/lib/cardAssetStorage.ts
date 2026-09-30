import { randomUUID } from "crypto";
import { statSync } from "fs";
import { readdir as readdirAsync, readFile as readFileAsync } from "fs/promises";
import { join } from "path";
import { Storage } from "@google-cloud/storage";
import { WORKSPACE_ROOT } from "./workspaceRoot.js";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

const localAssetsDir = join(WORKSPACE_ROOT, "artifacts/compost-heroes/public/assets");

function publicAssetLocation(key: string): { bucketName: string; objectName: string } {
  assertSafeObjectKey(key);
  const searchPaths = (process.env.PUBLIC_OBJECT_SEARCH_PATHS ?? "")
    .split(",").map((path) => path.trim()).filter(Boolean);
  if (!searchPaths.length) throw new Error("PUBLIC_OBJECT_SEARCH_PATHS is not configured");
  return parseBucketObjectPath(`${searchPaths[0].replace(/\/+$/, "")}/${key}`);
}

function privateStagingLocation(key: string): { bucketName: string; objectName: string } {
  if (!key.startsWith("card-upload-staging/")) throw new Error("Invalid staging key");
  assertSafeObjectKey(key);
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) throw new Error("PRIVATE_OBJECT_DIR is not configured");
  return parseBucketObjectPath(`${privateDir.replace(/\/+$/, "")}/${key}`);
}

function parseBucketObjectPath(rawPath: string): { bucketName: string; objectName: string } {
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const [bucketName, ...objectParts] = path.slice(1).split("/");
  if (!bucketName || !objectParts.length) throw new Error("Invalid public object storage path");
  return { bucketName, objectName: objectParts.join("/") };
}

function assertSafeObjectKey(key: string): void {
  if (!key || key.includes("\\") || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid asset key");
  }
}

export function getCardStagingKey(cardId: string, extension: string): string {
  return `card-upload-staging/${getSafeCardId(cardId)}_${randomUUID()}.${extension}`;
}

export function isCardStagingKey(cardId: string, key: string): boolean {
  return key.startsWith(`card-upload-staging/${getSafeCardId(cardId)}_`) &&
    !key.includes("\\") &&
    key.split("/").every((part) => part && part !== "." && part !== "..");
}

export function isServableCardAssetKey(key: string): boolean {
  return !key.startsWith("card-upload-staging/");
}

function getSafeCardId(cardId: string): string {
  return cardId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 80) || "card";
}

export async function createCardAssetUploadUrl(key: string): Promise<string> {
  if (!key.startsWith("card-upload-staging/")) throw new Error("Uploads must use a staging key");
  const { bucketName, objectName } = privateStagingLocation(key);
  const response = await fetch(`${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method: "PUT",
      expires_at: new Date(Date.now() + 2 * 60_000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Failed to create signed upload URL (${response.status})`);
  const result = await response.json() as { signed_url?: string };
  if (!result.signed_url) throw new Error("Object Storage did not return an upload URL");
  return result.signed_url;
}

export async function promoteVerifiedStagedCardAsset(key: string, declaredType: string): Promise<string | null> {
  if (!key.startsWith("card-upload-staging/")) return null;
  const sourceLocation = privateStagingLocation(key);
  const bucket = storage.bucket(sourceLocation.bucketName);
  const file = bucket.file(sourceLocation.objectName);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size);
  if (!Number.isFinite(size) || size <= 0 || size > 10 * 1024 * 1024 ||
      metadata.contentType !== declaredType) {
    await file.delete({ ignoreNotFound: true });
    return null;
  }
  const sourceVersion = metadata.generation
    ? bucket.file(sourceLocation.objectName, { generation: metadata.generation })
    : file;
  const [bytes] = await sourceVersion.download();
  const { validateCardImage } = await import("./validateCardImage.js");
  const verified = validateCardImage(bytes, declaredType);
  if (!verified) {
    await file.delete({ ignoreNotFound: true });
    return null;
  }

  // The final path is freshly generated after verification and is never exposed
  // to a client-signed PUT. Replays can only mutate their staging object.
  const finalKey = `card-overrides/${randomUUID()}.${verified.extension}`;
  const finalLocation = publicAssetLocation(finalKey);
  const destination = storage.bucket(finalLocation.bucketName).file(finalLocation.objectName);
  const [destinationExists] = await destination.exists();
  if (destinationExists) throw new Error("Generated final image key already exists");
  await sourceVersion.copy(destination, {
    contentType: verified.contentType,
    cacheControl: "public, max-age=31536000, immutable",
  });
  const [finalExists] = await destination.exists();
  if (!finalExists) throw new Error("Verified image promotion did not persist");
  return finalKey;
}

export async function deleteStagedCardAsset(key: string): Promise<void> {
  if (!key.startsWith("card-upload-staging/")) return;
  const { bucketName, objectName } = privateStagingLocation(key);
  await storage.bucket(bucketName).file(objectName).delete({ ignoreNotFound: true });
}

export async function saveMigratedAssetIfMissing(key: string, bytes: Buffer, contentType: string): Promise<void> {
  const { bucketName, objectName } = publicAssetLocation(key);
  const file = storage.bucket(bucketName).file(objectName);
  const [exists] = await file.exists();
  if (exists) return;
  await file.save(bytes, {
    resumable: false,
    metadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
  });
}

export async function streamCardAsset(key: string, res: import("express").Response): Promise<boolean> {
  if (!isServableCardAssetKey(key)) return false;
  const { bucketName, objectName } = publicAssetLocation(key);
  const file = storage.bucket(bucketName).file(objectName);
  const [exists] = await file.exists();
  if (!exists) return false;
  const [metadata] = await file.getMetadata();
  res.setHeader("Content-Type", metadata.contentType || "application/octet-stream");
  res.setHeader("Cache-Control", "public, max-age=86400");
  if (metadata.size) res.setHeader("Content-Length", String(metadata.size));
  await new Promise<void>((resolve, reject) => {
    const stream = file.createReadStream();
    stream.on("error", reject);
    res.on("finish", resolve);
    res.on("close", resolve);
    stream.pipe(res);
  });
  return true;
}

/** Copy existing local card images with stable keys. Files remain in place as
 * a rollback/fallback copy. Re-running skips objects already present.
 */
export async function migrateLocalCardAssets(): Promise<void> {
  const entries = await readdirAsync(localAssetsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(png|jpe?g|webp)$/i.test(entry.name)) continue;
    const bytes = await readFileAsync(join(localAssetsDir, entry.name));
    const contentType = mimeFromExtension(entry.name);
    await saveMigratedAssetIfMissing(entry.name, bytes, contentType);
  }
}

export function isLocalCardAssetAvailable(key: string): boolean {
  if (!key || key.includes("\\") || key.split("/").some((part) => !part || part === "." || part === "..")) return false;
  try {
    return statSync(join(localAssetsDir, key)).isFile();
  } catch {
    return false;
  }
}

export function mimeFromExtension(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return "application/octet-stream";
}
