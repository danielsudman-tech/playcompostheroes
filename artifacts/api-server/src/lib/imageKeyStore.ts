import type { CardSettingsStore } from "./cardSettingsStore.js";

let store: CardSettingsStore | null = null;

export function attachImageKeyStore(settingsStore: CardSettingsStore): void {
  store = settingsStore;
}

export function getImageKeyOverride(cardId: string): string | null {
  return store?.getAllOverrides()[cardId] ?? null;
}

export async function setImageKeyOverride(cardId: string, imageKey: string): Promise<void> {
  if (!store) throw new Error("Card settings store has not been initialized");
  await store.setImageKey(cardId, imageKey);
}

export async function removeImageKeyOverride(cardId: string): Promise<void> {
  if (!store) throw new Error("Card settings store has not been initialized");
  await store.setImageKey(cardId, null);
}

export function getAllOverrides(): Record<string, string> {
  return store?.getAllOverrides() ?? {};
}
