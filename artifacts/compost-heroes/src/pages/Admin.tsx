import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { assetUrl } from "@/lib/assetUrl";
import {
  Upload,
  CheckCircle,
  AlertCircle,
  Loader2,
  ArrowLeft,
  Trash2,
  ImageIcon,
  Plus,
  Minus,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface AdminCard {
  id: string;
  name: string;
  type: "hero" | "action";
  function: string;
  imageKey: string | null;
  hasHardcodedImage: boolean;
  hasOverrideImage: boolean;
  copies: number;
}

function useAdminCards() {
  return useQuery<AdminCard[]>({
    queryKey: ["admin-cards"],
    queryFn: async () => {
      const res = await fetch("/api/admin/cards");
      if (!res.ok) throw new Error("Failed to fetch cards");
      return res.json();
    },
  });
}

function CardAdminRow({ card }: { card: AdminCard }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const imageSrc = card.imageKey
    ? assetUrl(card.imageKey)
    : null;

  const copiesMutation = useMutation({
    mutationFn: async (copies: number) => {
      const res = await fetch(`/api/admin/cards/${card.id}/copies`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ copies }),
      });
      if (!res.ok) throw new Error("Failed to update copies");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-cards"] });
    },
    onError: () => {
      toast({ title: "Failed to update copies", variant: "destructive" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/cards/${card.id}/image`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to remove image");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-cards"] });
      toast({ title: "Image removed", description: card.name });
    },
    onError: () => {
      toast({ title: "Failed to remove image", variant: "destructive" });
    },
  });

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.split(",")[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const res = await fetch(`/api/admin/cards/${card.id}/image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageData: base64, mimeType: file.type, filename: file.name }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || "Upload failed");
      }

      await queryClient.invalidateQueries({ queryKey: ["admin-cards"] });
      toast({ title: "Image uploaded!", description: card.name });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className={cn(
      "flex items-center gap-4 p-4 border rounded-xl bg-card hover:bg-muted/20 transition-colors",
      card.copies === 0 ? "border-muted opacity-60" : "border-border"
    )}>
      {/* Image preview */}
      <div className="shrink-0 w-14 h-20 rounded-lg overflow-hidden border-2 border-border bg-muted flex items-center justify-center">
        {imageSrc ? (
          <img src={imageSrc} alt={card.name} className="w-full h-full object-cover" />
        ) : (
          <ImageIcon className="w-5 h-5 text-muted-foreground/40" />
        )}
      </div>

      {/* Card info */}
      <div className="flex-1 min-w-0">
        <div className="font-bold text-sm text-foreground leading-tight">{card.name}</div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <span className={cn(
            "text-[10px] font-bold uppercase px-2 py-0.5 rounded-full",
            card.type === "hero" ? "bg-green-100 text-green-800" : "bg-blue-100 text-blue-800"
          )}>
            {card.type}
          </span>
          <span className="text-[10px] text-muted-foreground">{card.function}</span>
          {card.copies === 0 && (
            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-red-100 text-red-700">
              Excluded
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-1 text-[10px]">
          {card.imageKey ? (
            <>
              <CheckCircle className="w-3 h-3 text-green-600 shrink-0" />
              <span className="text-green-700 font-medium truncate max-w-[180px]">{card.imageKey}</span>
              {card.hasOverrideImage && (
                <span className="bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full font-bold ml-1 shrink-0">override</span>
              )}
            </>
          ) : (
            <>
              <AlertCircle className="w-3 h-3 text-muted-foreground/50 shrink-0" />
              <span className="text-muted-foreground/50">No image</span>
            </>
          )}
        </div>
      </div>

      {/* Copies stepper */}
      <div className="shrink-0 flex flex-col items-center gap-1">
        <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Copies</span>
        <div className="flex items-center gap-1">
          <button
            className="w-6 h-6 rounded-md border border-border bg-background hover:bg-muted flex items-center justify-center transition-colors disabled:opacity-40"
            onClick={() => copiesMutation.mutate(Math.max(0, card.copies - 1))}
            disabled={copiesMutation.isPending || card.copies === 0}
            title="Remove one copy"
          >
            <Minus className="w-3 h-3" />
          </button>
          <span className={cn(
            "w-7 text-center font-bold text-sm tabular-nums",
            card.copies === 0 ? "text-muted-foreground/50" : "text-foreground"
          )}>
            {copiesMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mx-auto" /> : card.copies}
          </span>
          <button
            className="w-6 h-6 rounded-md border border-border bg-background hover:bg-muted flex items-center justify-center transition-colors disabled:opacity-40"
            onClick={() => copiesMutation.mutate(card.copies + 1)}
            disabled={copiesMutation.isPending}
            title="Add one copy"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Image actions */}
      <div className="shrink-0 flex flex-col items-stretch gap-1.5">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="text-xs font-bold h-7 px-2"
        >
          {uploading ? (
            <><Loader2 className="w-3 h-3 mr-1 animate-spin" />Uploading…</>
          ) : (
            <><Upload className="w-3 h-3 mr-1" />{card.imageKey ? "Replace" : "Upload"}</>
          )}
        </Button>
        {card.hasOverrideImage && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => removeMutation.mutate()}
            disabled={removeMutation.isPending}
            className="text-destructive hover:text-destructive text-xs h-7 px-2"
            title="Remove override image"
          >
            <Trash2 className="w-3 h-3 mr-1" />Clear
          </Button>
        )}
      </div>
    </div>
  );
}

export default function Admin() {
  const [, setLocation] = useLocation();
  const { data: cards, isLoading, error } = useAdminCards();
  const [filter, setFilter] = useState<"all" | "missing" | "done">("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "hero" | "action">("all");

  const filtered = (cards ?? []).filter((c) => {
    if (filter === "missing" && c.imageKey) return false;
    if (filter === "done" && !c.imageKey) return false;
    if (typeFilter !== "all" && c.type !== typeFilter) return false;
    return true;
  });

  const doneCount = (cards ?? []).filter((c) => c.imageKey).length;
  const total = (cards ?? []).length;
  const totalCopies = (cards ?? []).reduce((sum, c) => sum + c.copies, 0);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-card/95 backdrop-blur border-b border-border px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center gap-4">
          <button
            onClick={() => setLocation("/")}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <h1 className="font-display font-bold text-xl text-foreground">Card Image Admin</h1>
            <p className="text-xs text-muted-foreground">
              {doneCount}/{total} cards have images &nbsp;·&nbsp; {totalCopies} total cards in deck
            </p>
          </div>
          {/* Progress bar */}
          <div className="w-28 h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${total > 0 ? (doneCount / total) * 100 : 0}%` }}
            />
          </div>
        </div>

        {/* Filters */}
        <div className="max-w-3xl mx-auto mt-3 flex gap-2 flex-wrap">
          {(["all", "missing", "done"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "text-xs font-bold px-3 py-1.5 rounded-full border transition-colors capitalize",
                filter === f
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground border-border hover:text-foreground"
              )}
            >
              {f === "all" ? `All (${total})` : f === "missing" ? `Missing (${total - doneCount})` : `Done (${doneCount})`}
            </button>
          ))}
          <div className="w-px bg-border mx-1" />
          {(["all", "hero", "action"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setTypeFilter(f)}
              className={cn(
                "text-xs font-bold px-3 py-1.5 rounded-full border transition-colors capitalize",
                typeFilter === f
                  ? "bg-secondary text-secondary-foreground border-secondary"
                  : "bg-background text-muted-foreground border-border hover:text-foreground"
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-6 py-6">
        {isLoading && (
          <div className="flex justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="text-center py-12 text-destructive">
            <AlertCircle className="w-8 h-8 mx-auto mb-2" />
            <p className="font-bold">Failed to load cards</p>
          </div>
        )}

        {cards && (
          <>
            <div className="mb-4 bg-muted/40 border border-border rounded-xl px-4 py-3 text-xs text-muted-foreground">
              <strong className="text-foreground">Deck size: {totalCopies} cards.</strong> Use the
              &nbsp;<span className="font-bold">− / +</span>&nbsp; buttons to set how many copies of each card go in the deck.
              Set to <strong>0</strong> to exclude a card entirely. Changes take effect on new games.
            </div>
            <div className="flex flex-col gap-3">
              {filtered.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  No cards match this filter.
                </div>
              ) : (
                filtered.map((card) => <CardAdminRow key={card.id} card={card} />)
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
