import { useState } from "react";
import { Bot, UserMinus } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** Online-host-only controls for one other seat. Cover is reversible; remove is permanent. */
export function HostSeatControls({
  playerId, name, covered, pending, onCover, onRemove,
}: {
  playerId: string;
  name: string;
  covered: boolean;
  pending: boolean;
  onCover: () => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div className="flex flex-wrap gap-1 mt-1" onClick={stop} data-testid={`host-seat-controls-${playerId}`}>
      {!covered && (
        <button
          type="button" disabled={pending} onClick={onCover}
          data-testid={`button-cover-player-${playerId}`}
          className="flex items-center gap-1 rounded-lg border border-violet-200 bg-violet-50 px-2 py-1 text-[10px] font-bold text-violet-700 hover:bg-violet-100 disabled:opacity-50"
        >
          <Bot className="w-3 h-3" /> Cover with bot
        </button>
      )}
      <button
        type="button" disabled={pending} onClick={() => setConfirming(true)}
        data-testid={`button-remove-player-${playerId}`}
        className="flex items-center gap-1 rounded-lg border border-destructive/30 px-2 py-1 text-[10px] font-bold text-destructive hover:bg-destructive/10 disabled:opacity-50"
      >
        <UserMinus className="w-3 h-3" /> Remove from game
      </button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent onClick={stop}>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name} permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              {name}'s seat becomes a permanent bot, their seat link is revoked, and they cannot return to this game.
              To let them come back, use Cover with bot instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-remove-player">Keep {name}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-remove-player"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { setConfirming(false); onRemove(); }}
            >
              Remove permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
