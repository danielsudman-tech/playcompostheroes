import { useCallback, useEffect, useRef, useState } from "react";
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
}

/**
 * Client-only rolling updates. State is keyed by game+viewer credential+seat so a seat change
 * or handoff never carries personal updates across; nothing is persisted.
 */
export function useGameUpdates({ scope, lastEffect, localPlayerId, hidden = false, turn = null }: Options) {
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

  const effectSig = lastEffect ? effectSignature(lastEffect) : null;
  useEffect(() => {
    if (!lastEffect) return;
    const seen = seenEffect.current;
    const sig = effectSignature(lastEffect);
    if (seen.key === key && seen.sig === sig) return;
    seenEffect.current = { key, sig };
    push(updateFromEffect(lastEffect, localPlayerId, Date.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectSig, key]);

  const turnNumber = turn?.turnNumber ?? null;
  const turnPlayer = turn?.currentPlayerId ?? null;
  const turnPhase = turn?.phase ?? null;
  useEffect(() => {
    if (turnNumber === null || turnPhase === null) return;
    const n = turnNoticeFor(scope, { turnNumber, currentPlayerId: turnPlayer, phase: turnPhase }, Date.now());
    if (n) push(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnNumber, turnPlayer, turnPhase, key]);

  const updates = hidden || store.key !== key ? EMPTY : store.list;
  return { updates, log };
}
