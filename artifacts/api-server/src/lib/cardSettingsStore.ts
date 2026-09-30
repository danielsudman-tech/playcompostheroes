import { readFileSync } from "fs";
import { join } from "path";
import { pool } from "@workspace/db";
import { getAllCards } from "./cards.js";
import { WORKSPACE_ROOT } from "./workspaceRoot.js";
import { isLocalCardAssetAvailable, migrateLocalCardAssets } from "./cardAssetStorage.js";
import { attachCardSettingsStore } from "./cardCopiesStore.js";
import { attachImageKeyStore } from "./imageKeyStore.js";

type SettingsRow = { card_id: string; image_key: string | null; copies: number | null };
export type CardSettingsStore = {
  getAllCopies(): Record<string, number>;
  getAllOverrides(): Record<string, string>;
  setCopies(cardId: string, copies: number): Promise<void>;
  setImageKey(cardId: string, imageKey: string | null): Promise<void>;
};

const copies: Record<string, number> = {};
const overrides: Record<string, string> = {};

function parseLegacyJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const settingsStore: CardSettingsStore = {
  getAllCopies: () => ({ ...copies }),
  getAllOverrides: () => ({ ...overrides }),
  async setCopies(cardId, count) {
    await pool.query(
      `INSERT INTO compost_card_settings (card_id, copies) VALUES ($1, $2)
       ON CONFLICT (card_id) DO UPDATE SET copies = EXCLUDED.copies`,
      [cardId, count],
    );
    copies[cardId] = count;
  },
  async setImageKey(cardId, imageKey) {
    await pool.query(
      `INSERT INTO compost_card_settings (card_id, image_key) VALUES ($1, $2)
       ON CONFLICT (card_id) DO UPDATE SET image_key = EXCLUDED.image_key`,
      [cardId, imageKey],
    );
    if (imageKey === null) delete overrides[cardId];
    else overrides[cardId] = imageKey;
  },
};

let initializePromise: Promise<void> | null = null;

/** Create the additive settings table, import legacy JSON once, and hydrate the
 * process cache before any game or admin request can observe card configuration.
 * Existing DB values always win, so a restart never replays stale JSON over edits.
 */
export function initializeCardSettingsStore(): Promise<void> {
  if (!initializePromise) initializePromise = initialize().catch(error => {
    initializePromise = null;
    throw error;
  });
  return initializePromise;
}

async function initialize(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS compost_card_settings (
      card_id text PRIMARY KEY,
      image_key text,
      copies integer CHECK (copies IS NULL OR copies >= 0)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS compost_card_asset_uploads (
      staging_key text PRIMARY KEY,
      card_id text NOT NULL,
      final_key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const copiesPath = join(WORKSPACE_ROOT, "artifacts/api-server/src/lib/cardCopies.json");
  const overridesPath = join(WORKSPACE_ROOT, "artifacts/api-server/src/lib/imageKeys.json");
  const legacyCopies = parseLegacyJson<Record<string, number>>(copiesPath);
  const legacyOverrides = parseLegacyJson<Record<string, string>>(overridesPath);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const card of getAllCards()) {
      const copiesValue = legacyCopies[card.id];
      const candidateImageKey = legacyOverrides[card.id] ?? null;
      const imageKey = candidateImageKey && isLocalCardAssetAvailable(candidateImageKey)
        ? candidateImageKey
        : null;
      if (copiesValue !== undefined && (!Number.isInteger(copiesValue) || copiesValue < 0)) {
        throw new Error(`Invalid legacy copy count for ${card.id}`);
      }
      await client.query(
        `INSERT INTO compost_card_settings (card_id, image_key, copies)
         VALUES ($1, $2, $3)
         ON CONFLICT (card_id) DO NOTHING`,
        [card.id, imageKey, copiesValue ?? null],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  attachCardSettingsStore(settingsStore);
  attachImageKeyStore(settingsStore);
  await refreshCache();
  startLocalAssetMigration();
}

export async function finalizeCardImageOverride(
  cardId: string,
  stagingKey: string,
  promote: () => Promise<string | null>,
  removeStaging: () => Promise<void>,
): Promise<string | null> {
  const client = await pool.connect();
  let committed = false;
  let finalKey: string | null = null;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [stagingKey]);
    const consumed = await client.query<{ final_key: string }>(
      "SELECT final_key FROM compost_card_asset_uploads WHERE staging_key = $1",
      [stagingKey],
    );
    if (consumed.rowCount) {
      finalKey = consumed.rows[0].final_key;
      await client.query("COMMIT");
      committed = true;
    } else {
      finalKey = await promote();
      if (!finalKey) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        "INSERT INTO compost_card_asset_uploads (staging_key, card_id, final_key) VALUES ($1, $2, $3)",
        [stagingKey, cardId, finalKey],
      );
      await client.query(
        `INSERT INTO compost_card_settings (card_id, image_key) VALUES ($1, $2)
         ON CONFLICT (card_id) DO UPDATE SET image_key = EXCLUDED.image_key`,
        [cardId, finalKey],
      );
      await client.query("COMMIT");
      committed = true;
      overrides[cardId] = finalKey;
    }
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // The DB claim prevents concurrent/replayed finalization. A failed cleanup
  // only leaves an unservable staging object; it cannot change the final copy.
  try {
    await removeStaging();
  } catch (error) {
    console.error("Could not remove finalized card image staging object:", error);
  }
  return finalKey;
}

let assetMigrationStarted = false;
function startLocalAssetMigration(): void {
  if (assetMigrationStarted) return;
  assetMigrationStarted = true;
  const attempt = async () => {
    try {
      await migrateLocalCardAssets();
    } catch (error) {
      console.error("Local card asset migration failed; local assets remain available and migration will retry:", error);
      const retry = setTimeout(() => { void attempt(); }, 60_000);
      retry.unref();
    }
  };
  void attempt();
}

async function refreshCache(): Promise<void> {
  const { rows } = await pool.query<SettingsRow>(
    "SELECT card_id, image_key, copies FROM compost_card_settings",
  );
  for (const key of Object.keys(copies)) delete copies[key];
  for (const key of Object.keys(overrides)) delete overrides[key];
  for (const row of rows) {
    if (row.copies !== null) copies[row.card_id] = row.copies;
    if (row.image_key !== null) overrides[row.card_id] = row.image_key;
  }
}