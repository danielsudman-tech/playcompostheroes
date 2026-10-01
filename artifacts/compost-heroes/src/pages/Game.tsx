import { useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { Loader2 } from "lucide-react";

/** Keep existing game links working without mounting the retired game layout. */
export default function Game() {
  const { gameId } = useParams();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!gameId) return;
    setLocation(
      `/game/${encodeURIComponent(gameId)}/table${window.location.search}${window.location.hash}`,
      { replace: true }
    );
  }, [gameId, setLocation]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <Loader2 className="w-10 h-10 text-primary animate-spin" aria-label="Opening game table" />
    </div>
  );
}