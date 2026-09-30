import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getStoredToken, storeToken } from "@/hooks/use-game";
import {
  getFacilitatorEvents, createFacilitatorEvent, getFacilitatorEvent, updateFacilitatorEvent,
  createFacilitatorEventStreamTicket,
  controlFacilitatorEvent, controlFacilitatorEventTable, getPublicEvent, joinEvent, setEventReady,
  heartbeatEventPresence,
  getGetFacilitatorEventsQueryKey, getGetFacilitatorEventQueryKey, getGetPublicEventQueryKey,
  type EventDetail, type EventSummary, type PublicEvent, type EventControlResult, type EventTableResult, type EventInput,
} from "@workspace/api-client-react";

export interface EventSeat { playerId?: string; name?: string; playerName?: string; ready?: boolean; connected?: boolean; present?: boolean; lastSeenAt?: number | null }
export interface EventTable {
  gameId: string; tableNumber?: number; label?: string; name?: string; phase?: string; paused?: boolean;
  seats?: EventSeat[]; players?: EventSeat[]; playerCount?: number; readyCount?: number; maxPlayers?: number;
  turnNumber?: number; currentPlayerName?: string; pendingDecision?: string | null; winner?: string | null;
  openQuestions?: number; lastActivityAt?: number | null; disconnectedCount?: number; idleSeconds?: number;
  capacity?: number; occupied?: number; progress?: number; attention?: string[]; questions?: unknown[];
}
export interface EventRecord {
  id?: string; eventId?: string; code: string; name: string; status: "upcoming" | "active" | "ending" | "completed";
  tableCount?: number; maxPlayersPerTable?: number; playersPerTable?: number; assignmentMode?: "choose" | "auto";
  idleThresholdMinutes?: number; idleSeconds?: number; tables: EventTable[]; createdAt?: number; paused?: boolean;
}
export interface GuestEvent { code: string; name: string; status: string; assignmentMode?: "choose" | "auto"; tables: EventTable[]; maxPlayersPerTable?: number; playersPerTable?: number }
export interface EventJoin { gameId: string; token: string; playerId?: string; playerName?: string; tableNumber?: number }

export const eventId = (event: EventRecord) => event.eventId ?? event.id ?? "";
export const guestEventKey = (code: string) => getGetPublicEventQueryKey(code);
export const userToken = () => { try { return localStorage.getItem("compost_user_token") ?? ""; } catch { return ""; } };
const eventAuthCacheScope = () => {
  let hash = 0xcbf29ce484222325n;
  for (const character of userToken()) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(character.charCodeAt(0))) * 0x100000001b3n);
  }
  return hash.toString(16);
};
const facilitatorEventsKey = () => [...getGetFacilitatorEventsQueryKey(), eventAuthCacheScope()] as const;
export const eventKey = (id: string) => [...getGetFacilitatorEventQueryKey(id), eventAuthCacheScope()] as const;
export const rememberedEventSeat = (code: string): EventJoin | null => {
  try { const value = localStorage.getItem(`compost_event_${code.toLowerCase()}`); return value ? JSON.parse(value) as EventJoin : null; } catch { return null; }
};
export const moveRememberedEventSeat = (
  seat: EventJoin | null,
  sourceGameId: string,
  sourceToken: string,
  gameId: string,
  targetToken: string,
): EventJoin | null => {
  if (!seat || seat.gameId !== sourceGameId || seat.token !== sourceToken) return null;
  // The room-transfer SSE payload has only { gameId, targetToken }; it does not
  // include the destination event table number. Don't retain a potentially
  // incorrect table number from the source room.
  const { tableNumber: _sourceTableNumber, ...seatWithoutTable } = seat;
  return { ...seatWithoutTable, gameId, token: targetToken };
};
export const rememberEventSeat = (code: string, seat: EventJoin) => {
  storeToken(seat.gameId, seat.token);
  try { localStorage.setItem(`compost_event_${code.toLowerCase()}`, JSON.stringify(seat)); localStorage.setItem(`compost_game_event_code_${seat.gameId}`, code.toLowerCase()); } catch {}
};
export const transferRememberedEventSeat = (
  sourceGameId: string,
  sourceToken: string,
  gameId: string,
  targetToken: string,
) => {
  try {
    const code = localStorage.getItem(`compost_game_event_code_${sourceGameId}`)?.toLowerCase();
    if (!code) return;
    const saved = rememberedEventSeat(code);
    const moved = moveRememberedEventSeat(saved, sourceGameId, sourceToken, gameId, targetToken);
    if (!moved) return;

    const destinationCode = localStorage.getItem(`compost_game_event_code_${gameId}`);
    // A destination already associated with another event is not ours to change.
    if (destinationCode && destinationCode.toLowerCase() !== code) return;

    localStorage.setItem(`compost_event_${code}`, JSON.stringify(moved));
    localStorage.setItem(`compost_game_event_code_${gameId}`, code);
    if (localStorage.getItem(`compost_game_event_code_${sourceGameId}`)?.toLowerCase() === code) {
      localStorage.removeItem(`compost_game_event_code_${sourceGameId}`);
    }
    localStorage.removeItem(`compost_event_ready_${sourceGameId}`);

    // The player ID normally survives a transfer, but the server may assign a
    // new ID if that ID is already present in the destination room. Resolve the
    // authoritative destination identity with the transferred token.
    void fetch(`/api/games/${encodeURIComponent(gameId)}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: targetToken }),
      keepalive: true,
    }).then(async response => {
      if (!response.ok) return;
      const identity = await response.json() as Partial<EventJoin>;
      const current = rememberedEventSeat(code);
      if (!current || current.gameId !== gameId || current.token !== targetToken) return;
      const updated = {
        ...current,
        ...(typeof identity.playerId === "string" ? { playerId: identity.playerId } : {}),
        ...(typeof identity.playerName === "string" ? { playerName: identity.playerName } : {}),
      };
      localStorage.setItem(`compost_event_${code}`, JSON.stringify(updated));
    }).catch(() => {});
  } catch {}
};
export const updateRememberedEventSeatIdentity = (
  gameId: string,
  token: string,
  identity: { playerId?: string | null; playerName?: string },
) => {
  try {
    const code = localStorage.getItem(`compost_game_event_code_${gameId}`)?.toLowerCase();
    if (!code) return;
    const seat = rememberedEventSeat(code);
    if (!seat || seat.gameId !== gameId || seat.token !== token) return;
    const updated = {
      ...seat,
      ...(typeof identity.playerId === "string" ? { playerId: identity.playerId } : {}),
      ...(typeof identity.playerName === "string" ? { playerName: identity.playerName } : {}),
    };
    localStorage.setItem(`compost_event_${code}`, JSON.stringify(updated));
  } catch {}
};
export const getGameEventCode = (gameId: string) => { try { return localStorage.getItem(`compost_game_event_code_${gameId}`); } catch { return null; } };
export const getGameEventId = (gameId: string) => { try { return localStorage.getItem(`compost_game_event_id_${gameId}`); } catch { return null; } };
export const forgetEventSeat = (gameId: string) => { try { const code = getGameEventCode(gameId); if (code) localStorage.removeItem(`compost_event_${code}`); localStorage.removeItem(`compost_game_event_code_${gameId}`); localStorage.removeItem(`compost_event_ready_${gameId}`); } catch {} };
const normalizeTable = (t: EventDetail["tables"][number]): EventTable => ({
  ...t, seats: t.players.map(p => ({ ...p, name: p.playerName })), maxPlayers: t.capacity,
  playerCount: t.players.length, readyCount: t.players.filter(p => p.ready).length,
  currentPlayerName: t.currentTurnPlayerName ?? undefined, pendingDecision: t.pendingDecisionOwner,
  openQuestions: t.questions.length, lastActivityAt: t.lastMeaningfulActivityAt,
  disconnectedCount: t.players.filter(p => !p.connected).length,
});
const normalizeEvent = (event: EventDetail): EventRecord => ({
  ...event, idleThresholdMinutes: Math.max(2, Math.ceil(event.idleSeconds / 60)),
  tables: event.tables.map(normalizeTable),
});
const rememberHostEvent = (event: EventRecord) => {
  try { event.tables.forEach(table => localStorage.setItem(`compost_game_event_id_${table.gameId}`, event.eventId ?? "")); } catch {}
  return event;
};
const normalizeSummary = (event: EventSummary): EventRecord => ({ ...event, tables: [] });
const normalizeGuest = (event: PublicEvent): GuestEvent => ({
  ...event, assignmentMode: (event as PublicEvent & { assignmentMode?: "choose" | "auto" }).assignmentMode ?? "choose",
  tables: event.tables.map(t => ({ ...t, gameId: `table-${t.tableNumber}`, maxPlayers: t.capacity, playerCount: t.occupied })),
});
export function useEvents() {
  return useQuery({ queryKey: facilitatorEventsKey(), queryFn: async () => (await getFacilitatorEvents({ headers: { Authorization: `Bearer ${userToken()}` } })).map(normalizeSummary), refetchInterval: 10000 });
}
export function useEvent(id: string) {
  return useQuery({ queryKey: eventKey(id), queryFn: async () => rememberHostEvent(normalizeEvent(await getFacilitatorEvent(id, { headers: { Authorization: `Bearer ${userToken()}` } }))), enabled: !!id, refetchInterval: 10000 });
}
export function useGuestEvent(code: string) {
  return useQuery({ queryKey: guestEventKey(code), queryFn: async () => normalizeGuest(await getPublicEvent(code)), enabled: !!code, refetchInterval: 5000 });
}
export function useCreateEvent() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: async (data: { name: string; tableCount: number; playersPerTable: number; assignmentMode: "choose" | "auto"; idleThresholdMinutes: number }) => {
    const payload: EventInput & { assignmentMode: "choose" | "auto" } = { name: data.name, tableCount: data.tableCount, tableCapacities: Array(data.tableCount).fill(data.playersPerTable), idleSeconds: data.idleThresholdMinutes * 60, assignmentMode: data.assignmentMode, userToken: userToken() };
    return rememberHostEvent(normalizeEvent(await createFacilitatorEvent(payload)));
  }, onSuccess: (event) => { qc.invalidateQueries({ queryKey: facilitatorEventsKey() }); if (event.eventId) qc.setQueryData(eventKey(event.eventId), event); } });
}
export function useUpdateEvent(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: async (data: { name?: string; idleThresholdMinutes?: number }) => normalizeEvent(await updateFacilitatorEvent(id, { name: data.name, idleSeconds: data.idleThresholdMinutes ? data.idleThresholdMinutes * 60 : undefined, userToken: userToken() })), onSuccess: (event) => { qc.setQueryData(eventKey(id), event); qc.invalidateQueries({ queryKey: facilitatorEventsKey() }); } });
}
export interface ControlResult { results: EventTableResult[] }
export function useEventControl(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data: { action: "start" | "message" | "pause" | "resume" | "end"; text?: string }): Promise<EventControlResult> => controlFacilitatorEvent(id, { action: data.action === "pause" ? "pause_all" : data.action === "resume" ? "resume_all" : data.action, text: data.text, userToken: userToken() }), onSuccess: () => { qc.invalidateQueries({ queryKey: eventKey(id) }); qc.invalidateQueries({ queryKey: facilitatorEventsKey() }); } });
}
export function useTableControl(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data: { gameId: string; action: "message" | "pause" | "resume"; text?: string }): Promise<EventTableResult> => controlFacilitatorEventTable(id, data.gameId, { action: data.action, text: data.text, userToken: userToken() }), onSuccess: () => qc.invalidateQueries({ queryKey: eventKey(id) }) });
}
export function useJoinEvent(code: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data: { name: string; tableNumber?: number; existingToken?: string }): Promise<EventJoin> => joinEvent(code, data), onSuccess: (seat) => { rememberEventSeat(code, seat); qc.invalidateQueries({ queryKey: guestEventKey(code) }); } });
}
export function useReadyEvent(code: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (seat: EventJoin) => setEventReady(code, { token: getStoredToken(seat.gameId) ?? seat.token, ready: true }), onSuccess: () => qc.invalidateQueries({ queryKey: guestEventKey(code) }) });
}
export function useEventPresence(code: string, seat: EventJoin | null, enabled: boolean) {
  useEffect(() => {
    if (!code || !seat || !enabled) return;
    const send = () => {
      if (document.visibilityState === "visible") void heartbeatEventPresence(code, { token: getStoredToken(seat.gameId) ?? seat.token }).catch(() => {});
    };
    send();
    const timer = window.setInterval(send, 15000);
    document.addEventListener("visibilitychange", send);
    window.addEventListener("online", send);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", send); window.removeEventListener("online", send); };
  }, [code, seat?.gameId, seat?.token, enabled]);
}
export function useEventStream(id: string) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!id || !userToken()) return;
    let stopped = false;
    let source: EventSource | null = null;
    let retryTimer: number | undefined;
    const reconnect = async () => {
      try {
        const issued = await createFacilitatorEventStreamTicket(id, { userToken: userToken() });
        if (stopped) return;
        const nextSource = new EventSource(
          `/api/facilitator/events/${encodeURIComponent(id)}/stream?ticket=${encodeURIComponent(issued.ticket)}`,
        );
        source = nextSource;
        nextSource.onopen = () => setConnected(true);
        nextSource.onmessage = () => { qc.invalidateQueries({ queryKey: eventKey(id) }); };
        nextSource.onerror = () => {
          nextSource.close();
          if (source === nextSource) source = null;
          setConnected(false);
          qc.invalidateQueries({ queryKey: eventKey(id) });
          if (!stopped) retryTimer = window.setTimeout(() => { void reconnect(); }, 3000);
        };
      } catch {
        setConnected(false);
        qc.invalidateQueries({ queryKey: eventKey(id) });
        if (!stopped) retryTimer = window.setTimeout(() => { void reconnect(); }, 3000);
      }
    };
    void reconnect();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      source?.close();
      setConnected(false);
    };
  }, [id, qc]);
  return connected;
}