import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { getGetGameQueryKey } from "@workspace/api-client-react";
import type { GameAction, GameState } from "@workspace/api-client-react";

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
      body: JSON.stringify({ token: existingToken ?? undefined, password }),
    })
      .then(async (r) => {
        const data = await r.json();
        if (r.status === 403 && data.requiresPassword) {
          setRequiresPassword(true);
          if (data.error !== "This game is password protected") {
            setError(data.error ?? "Incorrect password");
          }
          return;
        }
        if (!r.ok) throw new Error(data.error ?? "Failed to claim slot");
        storeToken(gameId, data.token);
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
  onNudge?: (from: string) => void
) {
  const queryClient = useQueryClient();
  const onNudgeRef = useRef(onNudge);
  onNudgeRef.current = onNudge;
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
      onKicked?.();
    });

    source.addEventListener("nudge", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        onNudgeRef.current?.(data.from ?? "Someone");
      } catch {}
    });

    source.onerror = () => {
      setSseConnected(false);
      // Force a poll immediately so the player doesn't see stale state
      // while EventSource auto-reconnects in the background.
      queryClient.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
    };

    return () => {
      source.close();
      setSseConnected(false);
    };
  }, [gameId, token, isOnline, queryClient, onKicked]);

  return { sseConnected };
}

// ── Leave or kick a player from a waiting room ────────────────────────────────

export function useLeaveRoom(gameId: string | null, token: string | null) {
  return useMutation({
    mutationFn: async (playerId: string) => {
      const r = await fetch(`/api/games/${gameId}/players/${playerId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Failed to leave room");
      }
      return r.json();
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
      botPlayerIndices?: number[];
      botSkillLevels?: Record<number, "easy" | "medium" | "hard">;
    }) => {
      const r = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
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
        body: JSON.stringify(body),
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

// ── Facilitator assist controls (host token = player index 0) ────────────────

export function useNudgePlayer(gameId: string | null, token: string | null) {
  return useMutation({
    mutationFn: async (targetPlayerIndex: number) => {
      const r = await fetch(`/api/games/${gameId}/nudge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, targetPlayerIndex }),
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
        body: JSON.stringify({ token, paused }),
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

export function useFacilitatorResolve(gameId: string | null, token: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/games/${gameId}/facilitator-resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
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
        body: JSON.stringify(data),
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
        body: JSON.stringify({ token, botSlots }),
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
