import { useState } from "react";
import { MoveRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface TransferDestination {
  gameId: string;
  label?: string;
  playerCount?: number;
  maxPlayers?: number;
  phase?: string;
}

export function PlayerTransferControl({ player, rooms, pending, onTransfer }: {
  player: { id: string; name: string };
  rooms: TransferDestination[];
  pending: boolean;
  onTransfer: (targetGameId: string) => void;
}) {
  const [destination, setDestination] = useState("");
  if (!rooms.length) return null;
  return <div className="flex items-center gap-1.5 w-full sm:w-auto sm:ml-auto">
    <select
      value={destination}
      onChange={event => setDestination(event.target.value)}
      disabled={pending}
      className="min-w-0 flex-1 sm:w-44 h-8 px-2 rounded-lg border border-border bg-background text-xs"
      aria-label={`Transfer ${player.name} to another table`}
      data-testid={`select-transfer-room-${player.id}`}
    >
      <option value="">Destination table…</option>
      {rooms.map(room => <option key={room.gameId} value={room.gameId}>
        {room.label || `Room ${room.gameId}`} ({room.playerCount ?? 0}/{room.maxPlayers ?? 4})
      </option>)}
    </select>
    <Button size="sm" variant="outline" className="h-8 rounded-lg shrink-0"
      disabled={pending || !rooms.some(room => room.gameId === destination)}
      onClick={() => onTransfer(destination)}
      data-testid={`button-transfer-${player.id}`}>
      <MoveRight className="w-3.5 h-3.5 mr-1" /> Transfer
    </Button>
  </div>;
}
