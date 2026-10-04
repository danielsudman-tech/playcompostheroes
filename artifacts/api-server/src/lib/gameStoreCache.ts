export const FINISHED_GAME_CACHE_TTL_MS = 60 * 60 * 1_000;
export const IDLE_GAME_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const GAME_CACHE_EVICTION_BATCH_SIZE = 250;

export interface CacheableGameState {
  gameId: string;
  phase: string;
  endedAt?: number;
  eventId?: string;
}

interface CacheTiming {
  cachedAt: number;
  lastAccessedAt: number;
}

export interface GameCacheReadVersion {
  readonly gameId: string;
  readonly generation: number;
}

interface GameCacheGeneration {
  generation: number;
  readers: number;
}

function cloneSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Process-local snapshots are always copied on ingress/egress. The token index
 * is deliberately owned by the same cache so an evicted game cannot leave a
 * credential index behind.
 */
export class GameStoreCache<T extends CacheableGameState> {
  private readonly states = new Map<string, T>();
  private readonly tokenIndexes = new Map<string, Map<string, number>>();
  private readonly timings = new Map<string, CacheTiming>();
  private readonly eventMembership = new Set<string>();
  private readonly knownEventMembership = new Set<string>();
  // Generation records exist only while reads are in flight. This preserves
  // invalidation ordering without accumulating tombstones for arbitrary IDs.
  private readonly generations = new Map<string, GameCacheGeneration>();
  private stateSweep: Iterator<string> = this.states.keys();
  private tokenSweep: Iterator<string> = this.tokenIndexes.keys();

  getState(gameId: string, now = Date.now()): T | undefined {
    const state = this.states.get(gameId);
    if (!state) return undefined;
    this.touch(gameId, now);
    return cloneSnapshot(state);
  }

  beginRead(gameId: string): GameCacheReadVersion {
    let current = this.generations.get(gameId);
    if (!current) {
      current = { generation: 0, readers: 0 };
      this.generations.set(gameId, current);
    }
    current.readers++;
    return { gameId, generation: current.generation };
  }

  finishRead(read: GameCacheReadVersion): void {
    const current = this.generations.get(read.gameId);
    if (!current) return;
    current.readers--;
    if (current.readers <= 0) this.generations.delete(read.gameId);
  }

  publishIfCurrent(read: GameCacheReadVersion, publish: () => void): boolean {
    const current = this.generations.get(read.gameId);
    if (!current || current.generation !== read.generation) return false;
    publish();
    return true;
  }

  /** Call only after a durable write/commit or durable deletion has succeeded. */
  advanceGeneration(gameId: string): void {
    const current = this.generations.get(gameId);
    if (current) current.generation++;
  }

  clearGameIfCurrent(read: GameCacheReadVersion): boolean {
    return this.publishIfCurrent(read, () => this.clearGameContents(read.gameId));
  }

  setState(state: T, now = Date.now(), isEventMember?: boolean): void {
    const snapshot = cloneSnapshot(state);
    this.states.set(snapshot.gameId, snapshot);
    this.touch(snapshot.gameId, now);
    if (isEventMember === true || snapshot.eventId) {
      this.eventMembership.add(snapshot.gameId);
      this.knownEventMembership.add(snapshot.gameId);
    } else if (isEventMember === false) {
      this.eventMembership.delete(snapshot.gameId);
      this.knownEventMembership.add(snapshot.gameId);
    }
  }

  /** Drop a state snapshot after a custom-client write without trusting its transaction status. */
  invalidateState(gameId: string): void {
    this.advanceGeneration(gameId);
    this.states.delete(gameId);
    if (!this.tokenIndexes.has(gameId)) this.timings.delete(gameId);
  }

  deleteGame(gameId: string): void {
    this.advanceGeneration(gameId);
    this.clearGameContents(gameId);
  }

  markEventMembership(gameId: string, isEventMember: boolean): void {
    if (isEventMember) this.eventMembership.add(gameId);
    else this.eventMembership.delete(gameId);
    this.knownEventMembership.add(gameId);
  }

  hasEventMembership(gameId: string): boolean {
    return this.eventMembership.has(gameId);
  }

  knowsEventMembership(gameId: string): boolean {
    return this.knownEventMembership.has(gameId);
  }

  getTokenIndex(gameId: string, now = Date.now()): Map<string, number> | undefined {
    const index = this.tokenIndexes.get(gameId);
    if (index) this.touch(gameId, now);
    return index;
  }

  setTokenIndex(gameId: string, index: Map<string, number>, now = Date.now()): void {
    this.tokenIndexes.set(gameId, new Map(index));
    this.touch(gameId, now);
  }

  invalidateTokenIndex(gameId: string): void {
    this.advanceGeneration(gameId);
    this.tokenIndexes.delete(gameId);
    if (!this.states.has(gameId)) this.timings.delete(gameId);
  }

  /**
   * Inspect at most maxEntries state snapshots per pass. Finished rooms expire
   * after one hour; otherwise-idle non-event rooms expire after 24 hours.
   */
  evict(now = Date.now(), maxEntries = GAME_CACHE_EVICTION_BATCH_SIZE): string[] {
    const batchSize = Number.isInteger(maxEntries) && maxEntries > 0
      ? Math.min(maxEntries, GAME_CACHE_EVICTION_BATCH_SIZE)
      : GAME_CACHE_EVICTION_BATCH_SIZE;
    const evicted: string[] = [];
    let inspected = 0;
    while (inspected < batchSize) {
      const next = this.stateSweep.next();
      if (next.done) {
        this.stateSweep = this.states.keys();
        break;
      }
      inspected++;
      const gameId = next.value;
      const state = this.states.get(gameId);
      const timing = this.timings.get(gameId);
      if (!state || !timing) continue;

      const finishedAt = Number.isFinite(state.endedAt) ? state.endedAt! : timing.cachedAt;
      const finishedExpired = state.phase === "game_over" &&
        now - finishedAt >= FINISHED_GAME_CACHE_TTL_MS;
      const idleExpired = !this.eventMembership.has(gameId) &&
        now - timing.lastAccessedAt >= IDLE_GAME_CACHE_TTL_MS;
      if (finishedExpired || idleExpired) {
        this.deleteGame(gameId);
        evicted.push(gameId);
      }
    }

    // Token-only entries can exist after a cache miss/reload. They are never
    // needed to serve an event game without its state snapshot, and are bounded
    // by the same idle TTL.
    inspected = 0;
    while (inspected < batchSize) {
      const next = this.tokenSweep.next();
      if (next.done) {
        this.tokenSweep = this.tokenIndexes.keys();
        break;
      }
      inspected++;
      const gameId = next.value;
      if (this.states.has(gameId) || this.eventMembership.has(gameId)) continue;
      const timing = this.timings.get(gameId);
      if (timing && now - timing.lastAccessedAt >= IDLE_GAME_CACHE_TTL_MS) {
        this.invalidateTokenIndex(gameId);
        if (!evicted.includes(gameId)) evicted.push(gameId);
      }
    }
    return evicted;
  }

  private touch(gameId: string, now: number): void {
    const timing = this.timings.get(gameId);
    if (timing) timing.lastAccessedAt = now;
    else this.timings.set(gameId, { cachedAt: now, lastAccessedAt: now });
  }

  private clearGameContents(gameId: string): void {
    this.states.delete(gameId);
    this.tokenIndexes.delete(gameId);
    this.timings.delete(gameId);
    this.eventMembership.delete(gameId);
    this.knownEventMembership.delete(gameId);
  }
}