import { RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReplayReadiness, type ReplaySeat } from "./ReplayReadiness";
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
  AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";

export function PlayAgainButton({ pending, onConfirm, roundNumber, seats }: {
  pending: boolean; onConfirm: () => void; roundNumber?: number; seats?: ReplaySeat[];
}) {
  return <AlertDialog>
    <AlertDialogTrigger asChild>
      <Button disabled={pending} data-testid="button-play-again">
        <RefreshCcw className="w-4 h-4 mr-2" />{pending ? "Starting round…" : "Play again"}
      </Button>
    </AlertDialogTrigger>
    <AlertDialogContent className="z-[120] max-h-[calc(100dvh-2rem)] overflow-y-auto" overlayClassName="z-[119]">
      <AlertDialogHeader>
        <AlertDialogTitle>{roundNumber ? `Start round ${roundNumber + 1}?` : "Start another round?"}</AlertDialogTitle>
        <AlertDialogDescription>
          Everyone keeps their seat and room link. Fresh hands will be dealt and the board
          will be cleared. This round’s final standings will be saved in Previous rounds.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {seats && <ReplayReadiness seats={seats} />}
      <AlertDialogFooter>
        <AlertDialogCancel>Not yet</AlertDialogCancel>
        <AlertDialogAction disabled={pending} onClick={onConfirm} data-testid="button-confirm-play-again">
          Start new round
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
