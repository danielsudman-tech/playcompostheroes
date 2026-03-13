import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  getGame, 
  createGame, 
  performAction,
  getGetGameQueryKey
} from "@workspace/api-client-react";
import type { CreateGameRequest, GameAction } from "@workspace/api-client-react";

export function useGameState(gameId: string | null) {
  return useQuery({
    queryKey: gameId ? getGetGameQueryKey(gameId) : [],
    queryFn: async () => {
      if (!gameId) throw new Error("No game ID");
      return getGame(gameId);
    },
    enabled: !!gameId,
    refetchInterval: 1500,
    staleTime: 1000,
  });
}

export function useCreateNewGame() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateGameRequest) => {
      return createGame(data);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(getGetGameQueryKey(data.gameId), data);
    },
  });
}

export interface GameActionCallbacks {
  onError?: (message: string) => void;
  onSuccess?: (logEntry: string) => void;
}

export function useGameAction(gameId: string, callbacks?: GameActionCallbacks) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: GameAction) => {
      return performAction(gameId, action);
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
