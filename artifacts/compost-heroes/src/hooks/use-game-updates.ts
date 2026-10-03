import { systemNotices, type SystemUpdate } from "@/lib/serverLogNotices";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  emptyBotQueue, ingestBotUpdates, nextWakeMs, releaseDue, turnCueDelay, type BotQueueState, type BotTurnUpdate,
} from "@/lib/botUpdateQueue";
import type { EffectAnnouncementData } from "@/lib/effectAnnouncements";
import {
  addUpdate, effectSignature, noticeUpdate, scopeKey, turnNoticeFor, updateFromEffect, type TurnSnapshot,
  type GameUpdate, type GameUpdateTone, type GameUpdatesScope,
} from "@/lib/gameUpdates";

const EMPTY: GameUpdate[] = [];

interface Options {
  scope: GameUpdatesScope;
  lastEffect: EffectAnnouncementData | null | undefined;
  localPlayerId: string | null;
  /** True while a hidden hand-off screen is up: history is withheld. */
  hidden?: boolean;
  /** Optional: logs a one-time 'Your turn' notice on transitions (including the first active load). */
  turn?: TurnSnapshot | null;
  /** Server-run bot turns; staged ~1.5s apart in the single history. Undefined on older servers. */
  botTurnUpdates?: BotTurnUpdate[] | null;
  /** Bot seats whose lastEffect is covered by botTurnUpdates (kept separate from human effects). */
  botPlayerIds?: string[];
  /** Server (already sanitized) log; canonical timer/removal lines join the single history. */
  serverLog?: readonly string[] | null;
  /** Durable system updates (timer expiry, permanent removal); preferred over the log fallback. */
  systemUpdates?: readonly SystemUpdate[] | null;
  /** Fires when "Your turn" is released (after any staged bot updates). `initial` = first load. */
  onYourTurn?: (initial: boolean) => void;
}

/**
 * Client-only rolling updates. State is keyed by game+viewer credential+seat so a seat change
 * or handoff never carries personal updates across; nothing is persisted.
 */
export function useGameUpdates({ scope, lastEffect, localPlayerId, hidden = false, turn = null, botTurnUpdates, botPlayerIds, serverLog, systemUpdates, onYourTurn }: Options) {
  const key = scopeKey(scope);
  const [store, setStore] = useState<{ key: string; list: GameUpdate[] }>({ key, list: [] });
  const keyRef = useRef(key);
  keyRef.current = key;
  const seenEffect = useRef<{ key: string; sig: string | null }>({ key, sig: null });

  const push = useCallback((u: Omit<GameUpdate, "at" | "personal"> & { at?: number; personal?: boolean }) => {
    const full: GameUpdate = { at: Date.now(), personal: false, ...u };
    setStore((s) => {
      const base = s.key === keyRef.current ? s.list : [];
      return { key: keyRef.current, list: addUpdate(base, full) };
    });
  }, []);

  const log = useCallback((title: string, tone: GameUpdateTone = "notice", detail?: string, id?: string) => {
    push(noticeUpdate(id ?? `${tone}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, title, Date.now(), tone, detail));
  }, [push]);

  const botState = useRef<{ key: string; q: BotQueueState }>({ key, q: emptyBotQueue() });
  const pendingTurn = useRef<GameUpdate | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const yourTurnRef = useRef(onYourTurn);
  yourTurnRef.current = onYourTurn;
  const turnSeen = useRef(false);
  const botIdsRef = useRef(botPlayerIds);
  botIdsRef.current = botPlayerIds;

  // Local timers only: releases queued bot updates, then the held "Your turn" notice.
  const pump = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (botState.current.key !== keyRef.current) return;
    const now = Date.now();
    const rel = releaseDue(botState.current.q, now);
    botState.current.q = rel.state;
    if (rel.released) {
      const b = rel.released;
      push({ id: `bot:${b.id}`, tone: "effect", title: b.summary, lines: b.removalLine ? [b.summary, b.removalLine] : [b.summary], at: now, personal: false });
    }
    let wake = nextWakeMs(botState.current.q, now);
    if (wake == null && pendingTurn.current) {
      const delay = turnCueDelay(botState.current.q, now);
      if (delay === 0) {
        const n = pendingTurn.current;
        pendingTurn.current = null;
        push({ ...n, at: now });
        yourTurnRef.current?.(!turnSeen.current);
        turnSeen.current = true;
      } else wake = delay;
    }
    if (wake != null) timer.current = setTimeout(pump, Math.max(16, wake));
  }, [push]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useEffect(() => {
    if (botState.current.key !== key) {
      botState.current = { key, q: emptyBotQueue() };
      pendingTurn.current = null;
    }
    const res = ingestBotUpdates(botState.current.q, botTurnUpdates);
    botState.current.q = res.state;
    const now = Date.now();
    for (const b of res.immediate) push({ id: `bot:${b.id}`, tone: "effect", title: b.summary, lines: b.removalLine ? [b.summary, b.removalLine] : [b.summary], at: now, personal: false });
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botTurnUpdates, key]);

  useEffect(() => {
    for (const n of systemNotices(systemUpdates, serverLog)) push(noticeUpdate(n.id, n.text, n.at ?? Date.now(), "notice"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemUpdates?.length, systemUpdates?.[systemUpdates.length - 1]?.id, systemUpdates === undefined ? serverLog?.length : 0, key]);

  const effectSig = lastEffect ? effectSignature(lastEffect) : null;
  useEffect(() => {
    if (!lastEffect) return;
    const seen = seenEffect.current;
    const sig = effectSignature(lastEffect);
    if (seen.key === key && seen.sig === sig) return;
    seenEffect.current = { key, sig };
    // Bot plays are announced from botTurnUpdates; do not combine them with human effects.
    if (botTurnUpdates !== undefined && botIdsRef.current?.includes(lastEffect.playedById)) return;
    push(updateFromEffect(lastEffect, localPlayerId, Date.now(), turn?.turnNumber));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectSig, key]);

  const turnNumber = turn?.turnNumber ?? null;
  const turnPlayer = turn?.currentPlayerId ?? null;
  const turnPhase = turn?.phase ?? null;
  useEffect(() => {
    if (turnNumber === null || turnPhase === null) return;
    const n = turnNoticeFor(scope, { turnNumber, currentPlayerId: turnPlayer, phase: turnPhase }, Date.now());
    if (n) { pendingTurn.current = n; pump(); }
    else pendingTurn.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnNumber, turnPlayer, turnPhase, key]);

  const updates = hidden || store.key !== key ? EMPTY : store.list;
  return { updates, log };
}
