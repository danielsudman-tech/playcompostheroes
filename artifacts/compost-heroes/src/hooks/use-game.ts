import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  getGame, 
  createGame, 
  performAction,
  getGetGameQueryKey
} from "@workspace/api-client-react";
import type { CreateGameRequest, GameAction } from "@workspace/api-client-react";

// Hook to poll the game state so players see updates in real-time
export function useGameState(gameId: string | null) {
  return useQuery({
    queryKey: gameId ? getGetGameQueryKey(gameId) : [],
    queryFn: async () => {
      if (!gameId) throw new Error("No game ID");
      return getGame(gameId);
    },
    enabled: !!gameId,
    refetchInterval: 1500, // Poll every 1.5s for snappy multiplayer feel
    staleTime: 1000,
  });
}

// Hook to create a new game
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

// Hook to perform an action (draw, play, end turn)
export function useGameAction(gameId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: GameAction) => {
      return performAction(gameId, action);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(getGetGameQueryKey(gameId), data);
    },
    onError: (error) => {
      console.error("[game-action] error:", error);
    }
  });
}
