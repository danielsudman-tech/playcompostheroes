import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { AlertCircle, Lock, Loader2 } from "lucide-react";
import type { GameState } from "@workspace/api-client-react";
import { useCurrentUser } from "@/components/AppGate";
import { WaitingRoom } from "@/components/WaitingRoom";
import { useJoinRoom, type ClaimResult } from "@/hooks/use-game";
import { assetUrl } from "@/lib/assetUrl";

export interface OnlineRoomEntryProps {
  gameId: string;
  gameState: GameState;
  claim: ClaimResult | null;
  token: string | null;
  claimLoading: boolean;
  requiresPassword: boolean;
  claimError: string | null;
  doClaim: (password?: string) => void;
}

export function OnlineRoomEntry({
  gameId,
  gameState,
  claim,
  token,
  claimLoading,
  requiresPassword,
  claimError,
  doClaim,
}: OnlineRoomEntryProps) {
  const [, setLocation] = useLocation();
  const currentUser = useCurrentUser();
  const joinRoom = useJoinRoom(gameId);
  const [joinName, setJoinName] = useState(() => currentUser?.name ?? "");
  const [joinRoomPassword, setJoinRoomPassword] = useState("");
  const [joinPassword, setJoinPassword] = useState("");

  useEffect(() => {
    if (currentUser?.name && !joinName.trim()) setJoinName(currentUser.name);
  }, [currentUser?.name, joinName]);

  const joinedClaim = claim ?? joinRoom.data ?? null;
  const joinedToken = token ?? joinedClaim?.token ?? null;
  const hasPassword = gameState.hasPassword ?? false;

  if (gameState.phase === "waiting" && joinedToken && joinedClaim) {
    return (
      <WaitingRoom
        gameId={gameId}
        players={gameState.players}
        maxPlayers={gameState.maxPlayers ?? 4}
        playerIndex={joinedClaim.playerIndex}
        token={joinedToken}
        hasPassword={hasPassword}
        isFacilitated={false}
        turnTimerSeconds={gameState.turnTimerSeconds ?? 0}
      />
    );
  }

  if (gameState.phase === "waiting" && !joinedToken) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <img src={assetUrl("card-back.jpg")} alt="Compost Heroes" className="w-24 mx-auto rounded-xl shadow-lg mb-4" draggable={false} />
            <h1 className="text-3xl font-display font-bold text-foreground mb-2">Join Room</h1>
            <p className="text-muted-foreground text-sm">Enter your name to join this game.</p>
          </div>

          <form
            className="bg-card/80 backdrop-blur-xl rounded-3xl shadow-xl border border-border p-6 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const name = joinName.trim();
              if (!name) return;
              joinRoom.mutate({ name, password: joinRoomPassword.trim() || undefined });
            }}
          >
            <input
              autoFocus
              placeholder="Your name"
              value={joinName}
              onChange={(e) => setJoinName(e.target.value)}
              className="w-full h-12 px-4 rounded-xl border-2 border-border bg-background/50 text-base font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
            {hasPassword && (
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
                <input
                  type="password"
                  placeholder="Room password"
                  value={joinRoomPassword}
                  onChange={(e) => setJoinRoomPassword(e.target.value)}
                  className="w-full h-12 pl-9 pr-4 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                />
              </div>
            )}
            {joinRoom.error && (
              <p className="text-xs text-destructive text-center font-medium">{joinRoom.error.message}</p>
            )}
            <button
              type="submit"
              disabled={joinRoom.isPending || !joinName.trim()}
              className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-bold text-base hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {joinRoom.isPending ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : "Join Game"}
            </button>
            <button
              type="button"
              className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setLocation("/")}
            >
              Back to Lobby
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (requiresPassword) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-20 h-20 bg-primary/10 rounded-full mb-4 ring-8 ring-primary/5">
              <Lock className="w-9 h-9 text-primary" />
            </div>
            <h1 className="text-3xl font-display font-bold text-foreground mb-2">Password Required</h1>
            <p className="text-muted-foreground text-sm">This game is protected. Enter the password to join.</p>
          </div>

          <form
            className="bg-card/80 backdrop-blur-xl rounded-3xl shadow-xl border border-border p-6 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              doClaim(joinPassword.trim() || undefined);
            }}
          >
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
              <input
                type="password"
                autoFocus
                placeholder="Enter game password"
                value={joinPassword}
                onChange={(e) => setJoinPassword(e.target.value)}
                className="w-full h-12 pl-9 pr-4 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
            {claimLoading && (
              <p className="text-xs text-muted-foreground text-center flex items-center justify-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Checking…
              </p>
            )}
            {claimError && !claimLoading && (
              <p className="text-xs text-destructive text-center font-medium">{claimError}</p>
            )}
            <button
              type="submit"
              disabled={claimLoading || !joinPassword.trim()}
              className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-bold text-base hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {claimLoading ? "Joining…" : "Join Game"}
            </button>
            <button
              type="button"
              className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setLocation("/")}
            >
              Back to Lobby
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm text-center">
        {claimLoading ? (
          <Loader2 className="w-12 h-12 text-primary animate-spin mx-auto mb-4" />
        ) : (
          <AlertCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
        )}
        <h2 className="text-2xl font-display text-foreground mb-2">
          {claimLoading ? "Joining game..." : "Unable to join game"}
        </h2>
        {claimLoading ? (
          <p className="text-sm text-muted-foreground">Connecting to your seat…</p>
        ) : (
          <>
            <p className="text-sm text-destructive mb-4">{claimError ?? "Your player seat could not be confirmed."}</p>
            <button
              type="button"
              disabled={claimLoading}
              onClick={() => doClaim()}
              className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-bold hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              Try Again
            </button>
            <button
              type="button"
              className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors mt-4"
              onClick={() => setLocation("/")}
            >
              Back to Lobby
            </button>
          </>
        )}
      </div>
    </div>
  );
}