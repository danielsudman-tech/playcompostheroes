import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { getGetGameQueryKey } from "@workspace/api-client-react";
import type { GameAction, GameState } from "@workspace/api-client-react";
import { transferRememberedEventSeat, updateRememberedEventSeatIdentity } from "@/hooks/use-events";

// ── Token management ──────────────────────────────────────────────────────────

function tokenKey(gameId: string) {
  return `compost_token_${gameId}`;
}

export function getStoredToken(gameId: string): string | null {
  try {
    return localStorage.getItem(tokenKey(gameId));
  } catch {
    return null;
  }
}

export function storeToken(gameId: string, token: string) {
  try {
    localStorage.setItem(tokenKey(gameId), token);
  } catch {}
}

// ── Claim a player slot ───────────────────────────────────────────────────────

export interface ClaimResult {
  token: string;
  playerIndex: number;
  playerId: string;
  playerName: string;
}

// Registered-account token (set by AppGate). Online games require it
// server-side for creating/joining; other modes ignore it.
function getUserToken(): string | undefined {
  try {
    return localStorage.getItem("compost_user_token") ?? undefined;
  } catch {
    return undefined;
  }
}

function followMovedRoom(sourceGameId: string, sourceToken: string, data: { redirectGameId?: string; targetToken?: string }): boolean {
  if (!data.redirectGameId || !data.targetToken) return false;
  storeToken(data.redirectGameId, data.targetToken);
  transferRememberedEventSeat(sourceGameId, sourceToken, data.redirectGameId, data.targetToken);
  try { localStorage.removeItem(tokenKey(sourceGameId)); } catch {}
  window.location.assign(`/game/${encodeURIComponent(data.redirectGameId)}/table`);
  return true;
}

export function useClaimSlot(gameId: string | null, enabled: boolean) {
  const [claim, setClaim] = useState<ClaimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [requiresPassword, setRequiresPassword] = useState(false);
  const attempted = useRef(false);

  const doClaim = useCallback((password?: string) => {
    if (!gameId) return;
    const existingToken = getStoredToken(gameId);
    setLoading(true);
    setError(null);
    setRequiresPassword(false);

    fetch(`/api/games/${gameId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: existingToken ?? undefined, password, userToken: getUserToken() }),
    })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (r.status === 409 && gameId && followMovedRoom(gameId, existingToken ?? "", data)) return;
        if (r.status === 403 && data.requiresPassword) {
          setRequiresPassword(true);
          if (data.error !== "This game is password protected") {
            setError(data.error ?? "Incorrect password");
          }
          return;
        }
        if (!r.ok) throw new Error(data.error ?? "Failed to claim slot");
        storeToken(gameId, data.token);
        updateRememberedEventSeatIdentity(gameId, data.token, data);
        setClaim(data as ClaimResult);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [gameId]);

  useEffect(() => {
    if (!gameId || !enabled || attempted.current) return;
    attempted.current = true;
    doClaim();
  }, [gameId, enabled, doClaim]);

  return { claim, error, loading, requiresPassword, doClaim };
}

// ── Game state (polling for pass-and-play, SSE for online) ───────────────────

export function useGameState(gameId: string | null, token?: string | null) {
  return useQuery({
    queryKey: gameId ? getGetGameQueryKey(gameId) : [],
    queryFn: async () => {
      if (!gameId) throw new Error("No game ID");
      const url = token
        ? `/api/games/${gameId}?token=${encodeURIComponent(token)}`
        : `/api/games/${gameId}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error("Failed to fetch game state");
      return r.json() as Promise<GameState>;
    },
    enabled: !!gameId,
    // Online mode: SSE handles real-time updates; poll every 10s as a safety net
    // in case SSE silently drops so players never get permanently stuck.
    // Pass & Play: poll every 1.5s so the UI stays in sync.
    refetchInterval: (query) => {
      const m = query.state.data?.mode;
      if (m === "online" || m === "facilitated") return 10000;
      return 1500;
    },
    staleTime: 1000,
  });
}

// ── SSE subscription for online mode ─────────────────────────────────────────

export function useGameSse(
  gameId: string | null,
  token: string | null,
  isOnline: boolean,
  onKicked?: () => void,
  onNudge?: (from: string) => void,
  onRoomTransfer?: (data: { gameId: string; targetToken: string }) => void
) {
  const queryClient = useQueryClient();
  const onNudgeRef = useRef(onNudge);
  onNudgeRef.current = onNudge;
  const onKickedRef = useRef(onKicked);
  onKickedRef.current = onKicked;
  const onRoomTransferRef = useRef(onRoomTransfer);
  onRoomTransferRef.current = onRoomTransfer;
  const recoveryInProgress = useRef(false);
  const [sseConnected, setSseConnected] = useState(false);

  useEffect(() => {
    if (!gameId || !token || !isOnline) return;

    const url = `/api/games/${gameId}/events?token=${encodeURIComponent(token)}`;
    const source = new EventSource(url);

    source.onopen = () => {
      setSseConnected(true);
    };

    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        queryClient.setQueryData(getGetGameQueryKey(gameId), data);
        setSseConnected(true);
      } catch {}
    };

    source.addEventListener("kicked", () => {
      source.close();
      onKickedRef.current?.();
    });

    source.addEventListener("nudge", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        onNudgeRef.current?.(data.from ?? "Someone");
      } catch {}
    });

    source.addEventListener("room_transfer", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { gameId?: string; targetToken?: string };
        if (!data.gameId || !data.targetToken) return;
        storeToken(data.gameId, data.targetToken);
        transferRememberedEventSeat(gameId, token, data.gameId, data.targetToken);
        try { localStorage.removeItem(tokenKey(gameId)); } catch {}
        queryClient.invalidateQueries({ queryKey: getGetGameQueryKey(data.gameId) });
        source.close();
        onRoomTransferRef.current?.({ gameId: data.gameId, targetToken: data.targetToken });
      } catch {}
    });

    source.onerror = () => {
      setSseConnected(false);
      if (onRoomTransferRef.current && token && !recoveryInProgress.current) {
        recoveryInProgress.current = true;
        void fetch(`/api/games/${gameId}/claim`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, userToken: getUserToken() }),
        })
          .then(async (r) => {
            const data = await r.json().catch(() => ({}));
            if (r.status === 403 && data.error === "Invalid game token") {
              source.close();
              onKickedRef.current?.();
              return true;
            }
            return r.status === 409 && followMovedRoom(gameId, token, data);
          })
          .catch(() => false)
          .then((wasMoved) => {
            if (!wasMoved) queryClient.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          })
          .finally(() => { recoveryInProgress.current = false; });
        return;
      }
      // Force a poll immediately so the player doesn't see stale state
      // while EventSource auto-reconnects in the background.
      queryClient.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
    };

    return () => {
      source.close();
      setSseConnected(false);
    };
  }, [gameId, token, isOnline, queryClient]);

  return { sseConnected };
}

// ── Leave or remove a player ──────────────────────────────────────────────────

async function removePlayer(gameId: string | null, token: string | null, playerId: string) {
  if (!gameId || !token) throw new Error("Room access is missing");
  const r = await fetch(`/api/games/${gameId}/players/${encodeURIComponent(playerId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, userToken: getUserToken() }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as any).error ?? "Failed to remove player");
  }
  return r.json() as Promise<{ success: true }>;
}

export function useLeaveRoom(gameId: string | null, token: string | null) {
  return useMutation({
    mutationFn: (playerId: string) => removePlayer(gameId, token, playerId),
  });
}

export function useKickPlayer(gameId: string | null, token: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (playerId: string) => removePlayer(gameId, token, playerId),
    onSuccess: () => {
      if (gameId) queryClient.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
      queryClient.invalidateQueries({ queryKey: ["facilitator-rooms"] });
    },
  });
}

// ── List open waiting rooms ───────────────────────────────────────────────────

export interface RoomInfo {
  gameId: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
  hasPassword: boolean;
}

export function useRooms() {
  return useQuery({
    queryKey: ["rooms"],
    queryFn: async (): Promise<RoomInfo[]> => {
      const r = await fetch("/api/rooms");
      if (!r.ok) throw new Error("Failed to load rooms");
      return r.json();
    },
    refetchInterval: 5000,
  });
}

// ── Create new game ───────────────────────────────────────────────────────────

export function useCreateNewGame() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      playerNames?: string[];
      mode: "facilitator" | "standalone" | "online" | "facilitated";
      password?: string;
      hostName?: string;
      maxPlayers?: number;
      label?: string;
      botPlayerIndices?: number[];
      botSkillLevels?: Record<number, "easy" | "medium" | "hard">;
    }) => {
      const r = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, userToken: getUserToken() }),
      });
      if (!r.ok) {
        const err = await r.json();
        throw new Error(err.error ?? "Failed to create game");
      }
      return r.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(getGetGameQueryKey(data.gameId), data);
      // In online mode, store the creator's token
      if (data.creatorToken) {
        storeToken(data.gameId, data.creatorToken);
      }
    },
  });
}

// ── Game actions ─────────────────────────────────────────────────────────────

export interface GameActionCallbacks {
  onError?: (message: string) => void;
  onSuccess?: (logEntry: string) => void;
}

export function useGameAction(gameId: string, token?: string | null, callbacks?: GameActionCallbacks) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: GameAction) => {
      const body = token ? { ...action, token } : action;
      const r = await fetch(`/api/games/${gameId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, userToken: getUserToken() }),
      });
      if (!r.ok) {
        const err = await r.json();
        throw new Error(err.error ?? "Action failed");
      }
      return r.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(getGetGameQueryKey(gameId), data);
      if (callbacks?.onSuccess && data.log.length > 0) {
        const lastEntry = data.log[data.log.length - 1];
        callbacks.onSuccess(lastEntry);
      }
    },
    onError: (error) => {
      console.error("[game-action] error:", error);
      const msg = error instanceof Error
        ? error.message.replace(/^HTTP \d+ [^:]+:\s*/, "")
        : "An unexpected error occurred";
      callbacks?.onError?.(msg);
    }
  });
}

// ── Facilitator assist controls (host token = -1 for spectator hosts, 0 for legacy) ──

export function useNudgePlayer(gameId: string | null, token: string | null) {
  return useMutation({
    mutationFn: async (targetPlayerIndex: number) => {
      const r = await fetch(`/api/games/${gameId}/nudge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, targetPlayerIndex, userToken: getUserToken() }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Failed to nudge");
      }
      return r.json();
    },
  });
}

export function usePauseGame(gameId: string | null, token: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (paused: boolean) => {
      const r = await fetch(`/api/games/${gameId}/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, paused, userToken: getUserToken() }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Failed to update pause state");
      }
      return r.json() as Promise<GameState>;
    },
    onSuccess: (data) => {
      if (gameId) queryClient.setQueryData(getGetGameQueryKey(gameId), data);
    },
  });
}

export function useSendHostMessage(gameId: string | null, token: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) => {
      const r = await fetch(`/api/games/${gameId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, text, userToken: getUserToken() }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Failed to send message");
      }
      return r.json() as Promise<GameState>;
    },
    onSuccess: (data) => {
      if (gameId) queryClient.setQueryData(getGetGameQueryKey(gameId), data);
    },
  });
}

export function useAskQuestion(gameId: string | null, token: string | null) {
  return useMutation({
    mutationFn: async (text: string) => {
      const r = await fetch(`/api/games/${gameId}/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, text }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Failed to send question");
      }
      return r.json() as Promise<{ ok: boolean }>;
    },
  });
}

export function useResolveQuestion(gameId: string | null, token: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (questionId: string) => {
      const r = await fetch(`/api/games/${gameId}/question/${questionId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, userToken: getUserToken() }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Failed to resolve question");
      }
      return r.json() as Promise<GameState>;
    },
    onSuccess: (data) => {
      if (gameId) queryClient.setQueryData(getGetGameQueryKey(gameId), data);
    },
  });
}

export function useEndSession(gameId: string | null, token: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/games/${gameId}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, userToken: getUserToken() }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Failed to end session");
      }
      return r.json() as Promise<GameState>;
    },
    onSuccess: (data) => {
      if (gameId) queryClient.setQueryData(getGetGameQueryKey(gameId), data);
    },
  });
}

export function useReorderWaitingPlayers(gameId: string | null, token: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (playerIds: string[]) => {
      const r = await fetch(`/api/games/${gameId}/waiting/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, userToken: getUserToken(), playerIds }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Failed to reorder players");
      }
      return r.json() as Promise<GameState>;
    },
    onSuccess: (data) => {
      if (gameId) queryClient.setQueryData(getGetGameQueryKey(gameId), data);
    },
  });
}

export function useTransferWaitingPlayer(gameId: string | null, token: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { playerId: string; targetGameId: string }) => {
      const r = await fetch(`/api/games/${gameId}/waiting/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, userToken: getUserToken(), ...data }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Failed to transfer player");
      }
      return r.json() as Promise<{ success: true }>;
    },
    onSuccess: () => {
      if (gameId) queryClient.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
      queryClient.invalidateQueries({ queryKey: ["facilitator-rooms"] });
    },
  });
}

export interface FacilitatorRoomInfo {
  gameId: string;
  playerCount?: number;
  maxPlayers?: number;
  label?: string;
}

export function useFacilitatorRooms(enabled = true) {
  return useQuery({
    queryKey: ["facilitator-rooms"],
    queryFn: async (): Promise<FacilitatorRoomInfo[]> => {
      const userToken = getUserToken();
      const r = await fetch("/api/facilitator/rooms", {
        headers: { Authorization: `Bearer ${userToken ?? ""}` },
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Failed to load facilitator rooms");
      }
      const result = await r.json();
      return Array.isArray(result) ? result : (result.rooms ?? []);
    },
    enabled,
    refetchInterval: 10000,
  });
}

export function useFacilitatorResolve(gameId: string | null, token: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/games/${gameId}/facilitator-resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, userToken: getUserToken() }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Failed to resolve decision");
      }
      return r.json() as Promise<GameState>;
    },
    onSuccess: (data) => {
      if (gameId) queryClient.setQueryData(getGetGameQueryKey(gameId), data);
    },
  });
}

// ── Join a waiting-room game ──────────────────────────────────────────────────

export function useJoinRoom(gameId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; password?: string }) => {
      const r = await fetch(`/api/games/${gameId}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, userToken: getUserToken() }),
      });
      if (!r.ok) {
        const err = await r.json();
        throw new Error(err.error ?? "Failed to join");
      }
      return r.json() as Promise<{ token: string; playerIndex: number; playerId: string; playerName: string }>;
    },
    onSuccess: (data) => {
      if (gameId) {
        storeToken(gameId, data.token);
        queryClient.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
      }
    },
  });
}

// ── Start a waiting-room game (host only) ─────────────────────────────────────

export interface BotSlotPayload {
  name: string;
  skillLevel: "easy" | "medium" | "hard";
}

export function useStartGame(gameId: string | null, token?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (botSlots?: BotSlotPayload[]) => {
      const r = await fetch(`/api/games/${gameId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, botSlots, userToken: getUserToken() }),
      });
      if (!r.ok) {
        const err = await r.json();
        throw new Error(err.error ?? "Failed to start game");
      }
      return r.json();
    },
    onSuccess: (data) => {
      if (gameId) queryClient.setQueryData(getGetGameQueryKey(gameId), data);
    },
  });
}
