import type { CardSettingsStore } from "./cardSettingsStore.js";

let store: CardSettingsStore | null = null;

export function attachCardSettingsStore(settingsStore: CardSettingsStore): void {
  store = settingsStore;
}

export function getCardCopies(cardId: string): number {
  return store?.getAllCopies()[cardId] ?? 1;
}

export async function setCardCopies(cardId: string, count: number): Promise<void> {
  if (count < 0) count = 0;
  if (!store) throw new Error("Card settings store has not been initialized");
  await store.setCopies(cardId, count);
}

export function getAllCopies(): Record<string, number> {
  return store?.getAllCopies() ?? {};
}
