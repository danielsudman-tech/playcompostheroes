import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { getGetGameQueryKey } from "@workspace/api-client-react";
import type { GameAction } from "@workspace/api-client-react";

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
      return r.json();
    },
    enabled: !!gameId,
    // Online mode: stop polling once state is loaded (SSE handles real-time updates)
    // Pass & Play: poll every 1.5s so the UI stays in sync
    refetchInterval: (query) => {
      if (query.state.data?.mode === "online") return false;
      return 1500;
    },
    staleTime: 1000,
  });
}

// ── SSE subscription for online mode ─────────────────────────────────────────

export function useGameSse(gameId: string | null, token: string | null, isOnline: boolean) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!gameId || !token || !isOnline) return;

    const url = `/api/games/${gameId}/events?token=${encodeURIComponent(token)}`;
    const source = new EventSource(url);

    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        queryClient.setQueryData(getGetGameQueryKey(gameId), data);
      } catch {}
    };

    source.onerror = () => {
      // EventSource will auto-reconnect — no action needed
    };

    return () => source.close();
  }, [gameId, token, isOnline, queryClient]);
}

// ── Create new game ───────────────────────────────────────────────────────────

export function useCreateNewGame() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      playerNames?: string[];
      mode: "facilitator" | "standalone" | "online";
      password?: string;
      hostName?: string;
      maxPlayers?: number;
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
      if (gameId) storeToken(gameId, data.token);
      queryClient.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
    },
  });
}

// ── Start a waiting-room game (host only) ─────────────────────────────────────

export function useStartGame(gameId: string | null, token?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/games/${gameId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!r.ok) {
        const err = await r.json();
        throw new Error(err.error ?? "Failed to start game");
      }
      return r.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(getGetGameQueryKey(gameId), data);
    },
  });
}
