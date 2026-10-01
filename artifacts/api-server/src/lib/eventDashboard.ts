import type { PgQueryable } from "./gameStore.js";

export const EVENT_DETAIL_COALESCE_MS = 350;

type PendingEventDetail = {
  timer?: ReturnType<typeof setTimeout>;
  inFlight: boolean;
  dirty: boolean;
};

export class EventDetailCoalescer {
  private readonly pending = new Map<string, PendingEventDetail>();

  constructor(
    private readonly hasSubscribers: (eventId: string) => boolean,
    private readonly buildDetail: (eventId: string) => Promise<unknown>,
    private readonly push: (eventId: string, detail: unknown) => void,
    private readonly delayMs = EVENT_DETAIL_COALESCE_MS,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  enqueue(eventId: string): void {
    if (!this.hasSubscribers(eventId)) return;
    let state = this.pending.get(eventId);
    if (!state) {
      state = { inFlight: false, dirty: false };
      this.pending.set(eventId, state);
    }
    state.dirty = true;
    if (!state.inFlight && state.timer === undefined) this.schedule(eventId, state);
  }

  cancel(eventId: string): void {
    const state = this.pending.get(eventId);
    if (!state) return;
    if (state.timer !== undefined) clearTimeout(state.timer);
    this.pending.delete(eventId);
  }

  private schedule(eventId: string, state: PendingEventDetail): void {
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (this.pending.get(eventId) !== state) return;
      if (!this.hasSubscribers(eventId)) {
        this.pending.delete(eventId);
        return;
      }
      if (!state.dirty || state.inFlight) return;

      state.dirty = false;
      state.inFlight = true;
      void this.buildDetail(eventId)
        .then((detail) => {
          if (detail != null && this.pending.get(eventId) === state && this.hasSubscribers(eventId)) {
            this.push(eventId, detail);
          }
        })
        .catch((error) => this.onError(error))
        .finally(() => {
          state.inFlight = false;
          if (this.pending.get(eventId) !== state) return;
          if (state.dirty && this.hasSubscribers(eventId)) this.schedule(eventId, state);
          else this.pending.delete(eventId);
        });
    }, this.delayMs);
    (state.timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  }
}

export async function loadHostTokens(
  client: PgQueryable,
  gameIds: string[],
): Promise<Record<string, string>> {
  if (!gameIds.length) return {};
  const result = await client.query(
    `SELECT game_id, token FROM compost_game_tokens
      WHERE game_id = ANY($1::text[]) AND player_index = -1`,
    [gameIds],
  );
  return Object.fromEntries(result.rows.map((row: { game_id: string; token: string }) => [row.game_id, row.token]));
}