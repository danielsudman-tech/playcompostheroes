import React, { useState, useRef, useCallback, useEffect } from "react";
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
  Lock,
  Users,
  CreditCard,
  Download,
  BarChart2,
  LogIn,
  Gamepad2,
  Trophy,
  Activity,
  UserCheck,
  Archive,
  Github,
  RefreshCw,
  Database,
} from "lucide-react";
import { cn } from "@/lib/utils";

const ADMIN_KEY_STORAGE = "compost_admin_key";

// ── Types ──────────────────────────────────────────────────────────────────────

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

interface AdminUser {
  id: string;
  email: string;
  name: string;
  organization: string | null;
  role: string | null;
  createdAt: string;
  sessionCount: number;
}

interface AnalyticsSummary {
  totalUsers: number;
  totalLogins: number;
  totalGames: number;
  completedGames: number;
  activeGames: number;
  onlineGames: number;
}

interface DayCount { date: string; count: number; }
interface EventByType { eventType: string; count: number; }
interface GameByMode { mode: string; count: number; }
interface GameByPlayers { playerCount: number; count: number; }
interface RecentEvent { eventType: string; gameId: string | null; userId: string | null; userName: string | null; metadata: Record<string, unknown> | null; createdAt: string; }
interface TopUser { userId: string; name: string; email: string; loginCount: number; gamesCreated: number; lastLogin: string | null; }

interface AnalyticsData {
  summary: AnalyticsSummary;
  registrationsOverTime: DayCount[];
  loginsOverTime: DayCount[];
  eventsByType: EventByType[];
  gamesByMode: GameByMode[];
  gamesByPlayerCount: GameByPlayers[];
  recentEvents: RecentEvent[];
  topUsers: TopUser[];
}

// ── Admin auth helpers ─────────────────────────────────────────────────────────

function adminHeaders(key: string) {
  return { "Content-Type": "application/json", "x-admin-key": key };
}

async function verifyAdminKey(key: string): Promise<boolean> {
  const r = await fetch("/api/admin/cards", { headers: { "x-admin-key": key } });
  return r.ok;
}

// ── Password gate ──────────────────────────────────────────────────────────────

function AdminPasswordGate({ onAuth }: { onAuth: (key: string) => void }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw.trim()) return;
    setChecking(true);
    setError(null);
    const ok = await verifyAdminKey(pw.trim()).catch(() => false);
    setChecking(false);
    if (ok) {
      localStorage.setItem(ADMIN_KEY_STORAGE, pw.trim());
      onAuth(pw.trim());
    } else {
      setError("Incorrect password");
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-xs">
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
            <Lock className="w-5 h-5 text-primary" />
          </div>
          <h1 className="font-bold text-lg text-foreground">Admin Panel</h1>
          <p className="text-sm text-muted-foreground mt-1">Enter the admin password to continue</p>
        </div>
        <form onSubmit={handleSubmit} className="bg-card border border-border rounded-2xl p-5 space-y-3 shadow-lg">
          <input
            type="password"
            autoFocus
            placeholder="Admin password"
            value={pw}
            onChange={(e) => { setPw(e.target.value); setError(null); }}
            className="w-full h-11 px-4 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
          {error && <p className="text-xs text-destructive text-center">{error}</p>}
          <button
            type="submit"
            disabled={!pw.trim() || checking}
            className="w-full h-11 rounded-xl bg-primary text-primary-foreground font-bold text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {checking ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Cards tab ─────────────────────────────────────────────────────────────────

function CardAdminRow({ card, adminKey }: { card: AdminCard; adminKey: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const imageSrc = card.imageKey ? assetUrl(card.imageKey) : null;

  const copiesMutation = useMutation({
    mutationFn: async (copies: number) => {
      const r = await fetch(`/api/admin/cards/${card.id}/copies`, {
        method: "PUT",
        headers: adminHeaders(adminKey),
        body: JSON.stringify({ copies }),
      });
      if (!r.ok) throw new Error("Failed to update copies");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-cards"] }),
    onError: () => toast({ title: "Failed to update copies", variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/admin/cards/${card.id}/image`, {
        method: "DELETE",
        headers: { "x-admin-key": adminKey },
      });
      if (!r.ok) throw new Error("Failed to remove image");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-cards"] });
      toast({ title: "Image removed", description: card.name });
    },
    onError: () => toast({ title: "Failed to remove image", variant: "destructive" }),
  });

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const r = await fetch(`/api/admin/cards/${card.id}/image`, {
        method: "POST",
        headers: adminHeaders(adminKey),
        body: JSON.stringify({ imageData: base64, mimeType: file.type, filename: file.name }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || "Upload failed");
      }
      await queryClient.invalidateQueries({ queryKey: ["admin-cards"] });
      toast({ title: "Image uploaded!", description: card.name });
    } catch (err) {
      toast({ title: "Upload failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
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
      <div className="shrink-0 w-14 h-20 rounded-lg overflow-hidden border-2 border-border bg-muted flex items-center justify-center">
        {imageSrc ? <img src={imageSrc} alt={card.name} className="w-full h-full object-cover" /> : <ImageIcon className="w-5 h-5 text-muted-foreground/40" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-bold text-sm text-foreground leading-tight">{card.name}</div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <span className={cn("text-[10px] font-bold uppercase px-2 py-0.5 rounded-full", card.type === "hero" ? "bg-green-100 text-green-800" : "bg-blue-100 text-blue-800")}>{card.type}</span>
          <span className="text-[10px] text-muted-foreground">{card.function}</span>
          {card.copies === 0 && <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-red-100 text-red-700">Excluded</span>}
        </div>
        <div className="mt-1 flex items-center gap-1 text-[10px]">
          {card.imageKey ? (
            <><CheckCircle className="w-3 h-3 text-green-600 shrink-0" /><span className="text-green-700 font-medium truncate max-w-[180px]">{card.imageKey}</span>{card.hasOverrideImage && <span className="bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full font-bold ml-1 shrink-0">override</span>}</>
          ) : (
            <><AlertCircle className="w-3 h-3 text-muted-foreground/50 shrink-0" /><span className="text-muted-foreground/50">No image</span></>
          )}
        </div>
      </div>
      <div className="shrink-0 flex flex-col items-center gap-1">
        <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Copies</span>
        <div className="flex items-center gap-1">
          <button className="w-6 h-6 rounded-md border border-border bg-background hover:bg-muted flex items-center justify-center transition-colors disabled:opacity-40" onClick={() => copiesMutation.mutate(Math.max(0, card.copies - 1))} disabled={copiesMutation.isPending || card.copies === 0}><Minus className="w-3 h-3" /></button>
          <span className={cn("w-7 text-center font-bold text-sm tabular-nums", card.copies === 0 ? "text-muted-foreground/50" : "text-foreground")}>{copiesMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mx-auto" /> : card.copies}</span>
          <button className="w-6 h-6 rounded-md border border-border bg-background hover:bg-muted flex items-center justify-center transition-colors disabled:opacity-40" onClick={() => copiesMutation.mutate(card.copies + 1)} disabled={copiesMutation.isPending}><Plus className="w-3 h-3" /></button>
        </div>
      </div>
      <div className="shrink-0 flex flex-col items-stretch gap-1.5">
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading} className="text-xs font-bold h-7 px-2">
          {uploading ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" />Uploading…</> : <><Upload className="w-3 h-3 mr-1" />{card.imageKey ? "Replace" : "Upload"}</>}
        </Button>
        {card.hasOverrideImage && (
          <Button size="sm" variant="ghost" onClick={() => removeMutation.mutate()} disabled={removeMutation.isPending} className="text-destructive hover:text-destructive text-xs h-7 px-2" title="Remove override image">
            <Trash2 className="w-3 h-3 mr-1" />Clear
          </Button>
        )}
      </div>
    </div>
  );
}

function CardsTab({ adminKey }: { adminKey: string }) {
  const [filter, setFilter] = useState<"all" | "missing" | "done">("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "hero" | "action">("all");

  const { data: cards, isLoading, error } = useQuery<AdminCard[]>({
    queryKey: ["admin-cards"],
    queryFn: async () => {
      const r = await fetch("/api/admin/cards", { headers: { "x-admin-key": adminKey } });
      if (!r.ok) throw new Error("Failed to fetch cards");
      return r.json();
    },
  });

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
    <>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-muted-foreground">{doneCount}/{total} have images · {totalCopies} total in deck</p>
        <div className="w-28 h-2 bg-muted rounded-full overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${total > 0 ? (doneCount / total) * 100 : 0}%` }} />
        </div>
      </div>

      <div className="flex gap-2 flex-wrap mb-4">
        {(["all", "missing", "done"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={cn("text-xs font-bold px-3 py-1.5 rounded-full border transition-colors capitalize", filter === f ? "bg-primary text-primary-foreground border-primary" : "bg-background text-muted-foreground border-border hover:text-foreground")}>
            {f === "all" ? `All (${total})` : f === "missing" ? `Missing (${total - doneCount})` : `Done (${doneCount})`}
          </button>
        ))}
        <div className="w-px bg-border mx-1" />
        {(["all", "hero", "action"] as const).map((f) => (
          <button key={f} onClick={() => setTypeFilter(f)} className={cn("text-xs font-bold px-3 py-1.5 rounded-full border transition-colors capitalize", typeFilter === f ? "bg-secondary text-secondary-foreground border-secondary" : "bg-background text-muted-foreground border-border hover:text-foreground")}>{f}</button>
        ))}
      </div>

      {isLoading && <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>}
      {error && <div className="text-center py-12 text-destructive"><AlertCircle className="w-8 h-8 mx-auto mb-2" /><p className="font-bold">Failed to load cards</p></div>}
      {cards && (
        <>
          <div className="mb-4 bg-muted/40 border border-border rounded-xl px-4 py-3 text-xs text-muted-foreground">
            <strong className="text-foreground">Deck size: {totalCopies} cards.</strong> Use the <span className="font-bold">− / +</span> buttons to set copies. Set to <strong>0</strong> to exclude.
          </div>
          <div className="flex flex-col gap-3">
            {filtered.length === 0 ? <div className="text-center py-12 text-muted-foreground">No cards match this filter.</div> : filtered.map((card) => <CardAdminRow key={card.id} card={card} adminKey={adminKey} />)}
          </div>
        </>
      )}
    </>
  );
}

interface AdminGame {
  gameId: string;
  phase: string;
  mode: string;
  playerCount: number;
  playerNames: string;
  updatedAt: string;
  createdAt: string;
  completedAt: string | null;
  hasPassword: boolean;
}

interface GamesData {
  games: AdminGame[];
  phaseCounts: Record<string, number>;
  activeCount: number;
}

// ── Games tab ─────────────────────────────────────────────────────────────────

const PHASE_LABELS: Record<string, { label: string; color: string }> = {
  waiting: { label: "Waiting", color: "bg-amber-100 text-amber-800" },
  draw: { label: "Drawing", color: "bg-blue-100 text-blue-800" },
  play: { label: "Playing", color: "bg-green-100 text-green-800" },
  game_over: { label: "Finished", color: "bg-muted text-muted-foreground" },
};

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function GamesTab({ adminKey }: { adminKey: string }) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<"all" | "active" | "waiting" | "finished">("all");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { toast } = useToast();

  const { data, isLoading, error, refetch } = useQuery<GamesData>({
    queryKey: ["admin-games", adminKey, filter],
    queryFn: async () => {
      const res = await fetch(`/api/admin/games?phase=${filter}`, { headers: { "x-admin-key": adminKey } });
      if (!res.ok) throw new Error("Failed to fetch games");
      return res.json();
    },
    refetchInterval: 15_000,
  });

  const deleteGame = useMutation({
    mutationFn: async (gameId: string) => {
      const res = await fetch(`/api/admin/games/${gameId}`, {
        method: "DELETE",
        headers: adminHeaders(adminKey),
      });
      if (!res.ok) throw new Error("Failed to delete game");
    },
    onSuccess: (_data, gameId) => {
      toast({ title: "Game deleted", description: gameId });
      queryClient.invalidateQueries({ queryKey: ["admin-games"] });
      setDeletingId(null);
    },
    onError: () => {
      toast({ title: "Failed to delete", variant: "destructive" });
      setDeletingId(null);
    },
  });

  if (isLoading) return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  if (error || !data) return <div className="text-center py-12 text-destructive">Failed to load games. <button onClick={() => refetch()} className="underline">Retry</button></div>;

  const FILTERS: { key: typeof filter; label: string }[] = [
    { key: "all", label: `All (${(data.phaseCounts.waiting ?? 0) + (data.phaseCounts.draw ?? 0) + (data.phaseCounts.play ?? 0) + (data.phaseCounts.game_over ?? 0)})` },
    { key: "active", label: `Active (${data.activeCount})` },
    { key: "waiting", label: `Waiting (${data.phaseCounts.waiting ?? 0})` },
    { key: "finished", label: `Finished (${data.phaseCounts.game_over ?? 0})` },
  ];

  return (
    <div className="space-y-4">
      {/* Phase summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: "Active", value: data.activeCount, note: "updated <3h", color: "bg-green-600" },
          { label: "Waiting", value: data.phaseCounts.waiting ?? 0, note: "in lobby", color: "bg-amber-600" },
          { label: "Finished", value: data.phaseCounts.game_over ?? 0, note: "game over", color: "bg-muted-foreground" },
          { label: "Total", value: Object.values(data.phaseCounts).reduce((a, b) => a + b, 0), note: "all time", color: "bg-blue-600" },
        ].map(s => (
          <div key={s.label} className="bg-card border border-border rounded-xl p-3 flex flex-col gap-0.5">
            <div className={cn("w-6 h-6 rounded-md flex items-center justify-center mb-1", s.color)}>
              <Gamepad2 className="w-3 h-3 text-white" />
            </div>
            <div className="text-xl font-bold text-foreground">{s.value}</div>
            <div className="text-xs font-medium text-foreground">{s.label}</div>
            <div className="text-[10px] text-muted-foreground">{s.note}</div>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 flex-wrap">
        {FILTERS.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={cn("text-xs font-bold px-3 py-1.5 rounded-lg transition-colors",
              filter === f.key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground")}
          >{f.label}</button>
        ))}
        <button onClick={() => refetch()} className="ml-auto text-xs text-muted-foreground hover:text-foreground transition-colors px-2">↻ Refresh</button>
      </div>

      {/* Games list */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        {data.games.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground italic">No games found</div>
        )}
        <div className="divide-y divide-border">
          {data.games.map(g => {
            const phaseInfo = PHASE_LABELS[g.phase] ?? { label: g.phase, color: "bg-muted text-muted-foreground" };
            const isStale = g.phase !== "game_over" && g.phase !== "waiting" &&
              (Date.now() - new Date(g.updatedAt).getTime()) > 3 * 3600 * 1000;
            const confirmingDelete = deletingId === g.gameId;
            return (
              <div key={g.gameId} className={cn("px-4 py-3 flex items-start gap-3", isStale && "opacity-50")}>
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded-full", phaseInfo.color)}>{phaseInfo.label}</span>
                    <span className="text-[10px] bg-muted text-muted-foreground font-medium px-1.5 py-0.5 rounded-full capitalize">{g.mode}</span>
                    {g.hasPassword && <span className="text-[10px] text-muted-foreground">🔒</span>}
                    {isStale && <span className="text-[10px] text-amber-600 font-semibold">stale</span>}
                  </div>
                  <div className="text-xs font-medium text-foreground">{g.playerNames || "—"}</div>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span>{g.playerCount} player{g.playerCount !== 1 ? "s" : ""}</span>
                    <span>·</span>
                    <span title={g.updatedAt}>updated {timeAgo(g.updatedAt)}</span>
                    <span>·</span>
                    <span className="font-mono">{g.gameId}</span>
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  {confirmingDelete ? (
                    <>
                      <button onClick={() => setDeletingId(null)} className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
                      <button onClick={() => deleteGame.mutate(g.gameId)} disabled={deleteGame.isPending}
                        className="text-[10px] font-bold text-destructive border border-destructive/30 rounded px-2 py-1 hover:bg-destructive/10 transition-colors">
                        {deleteGame.isPending ? "…" : "Delete"}
                      </button>
                    </>
                  ) : (
                    <button onClick={() => setDeletingId(g.gameId)}
                      className="text-[10px] text-muted-foreground/40 hover:text-destructive transition-colors p-1">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Backups tab ───────────────────────────────────────────────────────────────

interface GitHubStatus {
  configured: boolean;
  repo: string | null;
  remoteUrl: string | null;
  lastCommit: string | null;
}

function BackupsTab({ adminKey }: { adminKey: string }) {
  const { toast } = useToast();
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const headers = { "x-admin-key": adminKey };

  const { data: ghStatus, isLoading: ghLoading, refetch: refetchGh } = useQuery<GitHubStatus>({
    queryKey: ["admin-backup-github-status", adminKey],
    queryFn: async () => {
      const res = await fetch("/api/admin/backup/github/status", { headers });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const handleDbDownload = () => {
    // Use ?adminKey= since anchor clicks can't set custom headers
    const a = document.createElement("a");
    a.href = `/api/admin/backup/db?adminKey=${encodeURIComponent(adminKey)}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast({ title: "Database backup downloading…" });
  };

  const handleGithubPush = async () => {
    setPushing(true);
    setPushResult(null);
    try {
      const res = await fetch("/api/admin/backup/github/push", {
        method: "POST",
        headers,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Push failed");
      setPushResult({ ok: true, msg: `Pushed to ${data.repo} at ${new Date(data.pushedAt).toLocaleTimeString()}` });
      toast({ title: "Pushed to GitHub!" });
      refetchGh();
    } catch (err: any) {
      const msg = err?.message ?? "Unknown error";
      setPushResult({ ok: false, msg });
      toast({ title: "Push failed", description: msg, variant: "destructive" });
    } finally {
      setPushing(false);
    }
  };

  return (
    <div className="space-y-6">

      {/* Database backup */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 pt-4 pb-3 border-b border-border flex items-center gap-2">
          <Database className="w-4 h-4 text-primary" />
          <div className="text-sm font-bold text-foreground">Database Backup</div>
        </div>
        <div className="px-4 py-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Downloads a full SQL dump of all users, games, sessions, analytics, and card data.
            Runs <code className="bg-muted px-1 rounded">pg_dump</code> on demand — no scheduled copy is stored on the server.
          </p>
          <button
            onClick={handleDbDownload}
            className="flex items-center gap-2 bg-primary text-primary-foreground text-sm font-bold px-4 py-2 rounded-xl hover:opacity-90 transition-opacity"
          >
            <Download className="w-4 h-4" />
            Download .sql backup
          </button>
        </div>
      </div>

      {/* GitHub code backup */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 pt-4 pb-3 border-b border-border flex items-center gap-2">
          <Github className="w-4 h-4 text-primary" />
          <div className="text-sm font-bold text-foreground">Code Backup → GitHub</div>
          <button onClick={() => refetchGh()} className="ml-auto text-muted-foreground hover:text-foreground transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="px-4 py-4 space-y-4">
          {ghLoading ? (
            <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : (
            <>
              {/* Status row */}
              <div className="flex items-center gap-2">
                {ghStatus?.configured ? (
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-green-700 bg-green-50 border border-green-200 px-2 py-1 rounded-full">
                    <CheckCircle className="w-3.5 h-3.5" /> Configured
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-full">
                    <AlertCircle className="w-3.5 h-3.5" /> Not configured
                  </span>
                )}
                {ghStatus?.repo && (
                  <span className="text-xs text-muted-foreground font-mono">{ghStatus.repo}</span>
                )}
              </div>

              {/* Last commit */}
              {ghStatus?.lastCommit && (
                <div className="text-xs text-muted-foreground">
                  Last backup: <span className="font-mono text-foreground">{ghStatus.lastCommit}</span>
                </div>
              )}

              {/* Setup instructions if not configured */}
              {!ghStatus?.configured && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-1.5 text-xs text-amber-900">
                  <div className="font-semibold">Setup required:</div>
                  <ol className="list-decimal ml-4 space-y-1">
                    <li>Add a <strong>GITHUB_TOKEN</strong> secret in Replit (GitHub PAT with <em>repo</em> permission)</li>
                    <li>Add a <strong>GITHUB_BACKUP_REPO</strong> env var (e.g. <code className="bg-amber-100 px-1 rounded">yourname/compost-heroes-backup</code>)</li>
                    <li>Create that repo on GitHub (private recommended)</li>
                    <li>Restart the API server workflow, then come back here</li>
                  </ol>
                </div>
              )}

              {/* Push button */}
              <button
                onClick={handleGithubPush}
                disabled={pushing || !ghStatus?.configured}
                className="flex items-center gap-2 bg-primary text-primary-foreground text-sm font-bold px-4 py-2 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {pushing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Github className="w-4 h-4" />}
                {pushing ? "Pushing…" : "Push to GitHub now"}
              </button>

              {/* Push result */}
              {pushResult && (
                <div className={cn(
                  "text-xs px-3 py-2 rounded-lg border",
                  pushResult.ok
                    ? "bg-green-50 border-green-200 text-green-800"
                    : "bg-red-50 border-red-200 text-red-800"
                )}>
                  {pushResult.ok ? <CheckCircle className="inline w-3.5 h-3.5 mr-1" /> : <AlertCircle className="inline w-3.5 h-3.5 mr-1" />}
                  {pushResult.msg}
                </div>
              )}
            </>
          )}
        </div>
      </div>

    </div>
  );
}

// ── Analytics tab ─────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, color }: { icon: React.ElementType; label: string; value: number | string; sub?: string; color: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-1">
      <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center mb-1", color)}>
        <Icon className="w-4 h-4 text-white" />
      </div>
      <div className="text-2xl font-bold text-foreground">{value}</div>
      <div className="text-sm font-medium text-foreground">{label}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground w-6 text-right">{value}</span>
    </div>
  );
}

function SparkLine({ data, color }: { data: DayCount[]; color: string }) {
  if (!data.length) return <div className="text-xs text-muted-foreground italic">No data yet</div>;
  const max = Math.max(...data.map(d => d.count), 1);
  return (
    <div className="flex items-end gap-0.5 h-16 w-full">
      {data.map((d, i) => (
        <div
          key={i}
          title={`${d.date}: ${d.count}`}
          style={{ height: `${Math.max(4, (d.count / max) * 100)}%`, flex: 1 }}
          className={cn("rounded-t-sm min-w-[3px] transition-all", color)}
        />
      ))}
    </div>
  );
}

const EVENT_LABELS: Record<string, string> = {
  register: "Registered",
  login: "Logged in",
  game_created: "Started game",
  player_joined: "Joined game",
  game_completed: "Finished game",
};

function AnalyticsTab({ adminKey }: { adminKey: string }) {
  const { data, isLoading, error, refetch } = useQuery<AnalyticsData>({
    queryKey: ["admin-analytics", adminKey],
    queryFn: async () => {
      const res = await fetch("/api/admin/analytics", { headers: { "x-admin-key": adminKey } });
      if (!res.ok) throw new Error("Failed to fetch analytics");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  if (isLoading) return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  if (error || !data) return <div className="text-center py-12 text-destructive">Failed to load analytics. <button onClick={() => refetch()} className="underline">Retry</button></div>;

  const { summary, registrationsOverTime, loginsOverTime, eventsByType, gamesByMode, gamesByPlayerCount, recentEvents, topUsers } = data;
  const maxEventCount = Math.max(...eventsByType.map(e => e.count), 1);

  return (
    <div className="space-y-8">
      {/* Summary Cards */}
      <div>
        <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-3">Overview</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatCard icon={UserCheck} label="Registered Users" value={summary.totalUsers} color="bg-emerald-600" />
          <StatCard icon={LogIn} label="Total Logins" value={summary.totalLogins} color="bg-blue-600" />
          <StatCard icon={Gamepad2} label="Games Started" value={summary.totalGames} sub={`${summary.onlineGames} online`} color="bg-violet-600" />
          <StatCard icon={Trophy} label="Games Completed" value={summary.completedGames} color="bg-amber-600" />
          <StatCard icon={Activity} label="Active Games" value={summary.activeGames} sub="in progress" color="bg-rose-600" />
        </div>
      </div>

      {/* Activity charts */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-sm font-bold text-foreground mb-3">New Registrations (last 30 days)</div>
          <SparkLine data={registrationsOverTime} color="bg-emerald-500" />
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-sm font-bold text-foreground mb-3">Logins (last 30 days)</div>
          <SparkLine data={loginsOverTime} color="bg-blue-500" />
        </div>
      </div>

      {/* Events breakdown */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-sm font-bold text-foreground mb-3">Events (last 30 days)</div>
          <div className="space-y-2">
            {eventsByType.length === 0 && <div className="text-xs text-muted-foreground italic">No events yet</div>}
            {eventsByType.map(e => (
              <div key={e.eventType} className="space-y-0.5">
                <div className="flex justify-between text-xs">
                  <span className="text-foreground font-medium">{EVENT_LABELS[e.eventType] ?? e.eventType}</span>
                </div>
                <MiniBar value={e.count} max={maxEventCount} color="bg-primary" />
              </div>
            ))}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl p-4 space-y-4">
          <div>
            <div className="text-sm font-bold text-foreground mb-2">Games by Mode</div>
            <div className="space-y-1.5">
              {gamesByMode.length === 0 && <div className="text-xs text-muted-foreground italic">No data yet</div>}
              {gamesByMode.map(m => {
                const maxMode = Math.max(...gamesByMode.map(x => x.count), 1);
                return (
                  <div key={m.mode} className="space-y-0.5">
                    <div className="text-xs text-foreground font-medium capitalize">{m.mode}</div>
                    <MiniBar value={m.count} max={maxMode} color="bg-violet-500" />
                  </div>
                );
              })}
            </div>
          </div>
          <div>
            <div className="text-sm font-bold text-foreground mb-2">Games by Player Count</div>
            <div className="space-y-1.5">
              {gamesByPlayerCount.length === 0 && <div className="text-xs text-muted-foreground italic">No data yet</div>}
              {gamesByPlayerCount.map(g => {
                const maxP = Math.max(...gamesByPlayerCount.map(x => x.count), 1);
                return (
                  <div key={g.playerCount} className="space-y-0.5">
                    <div className="text-xs text-foreground font-medium">{g.playerCount} players</div>
                    <MiniBar value={g.count} max={maxP} color="bg-amber-500" />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Top Users */}
      {topUsers.length > 0 && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-4 pt-4 pb-2 border-b border-border">
            <div className="text-sm font-bold text-foreground">Top Users by Activity</div>
          </div>
          <div className="divide-y divide-border">
            {topUsers.slice(0, 10).map(u => (
              <div key={u.userId} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-foreground truncate">{u.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs text-foreground"><span className="font-semibold">{u.loginCount}</span> logins</div>
                  <div className="text-xs text-muted-foreground"><span className="font-semibold">{u.gamesCreated}</span> games</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Activity Feed */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 pt-4 pb-2 border-b border-border flex items-center justify-between">
          <div className="text-sm font-bold text-foreground">Recent Activity</div>
          <button onClick={() => refetch()} className="text-xs text-muted-foreground hover:text-foreground transition-colors">Refresh</button>
        </div>
        {recentEvents.length === 0 && <div className="px-4 py-6 text-xs text-muted-foreground italic text-center">No events recorded yet</div>}
        <div className="divide-y divide-border max-h-80 overflow-y-auto">
          {recentEvents.map((ev, i) => {
            const d = new Date(ev.createdAt);
            const label = EVENT_LABELS[ev.eventType] ?? ev.eventType;
            const who = ev.userName ?? ev.userId ?? "—";
            const details: string[] = [];
            if (ev.metadata) {
              if (ev.metadata.mode) details.push(String(ev.metadata.mode));
              if (ev.metadata.playerCount) details.push(`${ev.metadata.playerCount} players`);
              if (ev.metadata.winner) details.push(`winner: ${ev.metadata.winner}`);
            }
            return (
              <div key={i} className="px-4 py-2 flex items-center gap-3 text-xs">
                <div className="w-20 shrink-0 text-muted-foreground">{d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-foreground">{label}</span>
                  {who !== "—" && <span className="text-muted-foreground"> · {who}</span>}
                  {details.length > 0 && <span className="text-muted-foreground"> · {details.join(", ")}</span>}
                </div>
                <div className="shrink-0 text-muted-foreground">{d.toLocaleDateString([], { month: "short", day: "numeric" })}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Users tab ─────────────────────────────────────────────────────────────────

function UsersTab({ adminKey }: { adminKey: string }) {
  const [search, setSearch] = useState("");

  const { data: users, isLoading, error } = useQuery<AdminUser[]>({
    queryKey: ["admin-users"],
    queryFn: async () => {
      const r = await fetch("/api/admin/users", { headers: { "x-admin-key": adminKey } });
      if (!r.ok) throw new Error("Failed to fetch users");
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const filtered = (users ?? []).filter((u) => {
    const q = search.toLowerCase();
    return !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || (u.organization ?? "").toLowerCase().includes(q);
  });

  const exportCsv = () => {
    if (!users) return;
    const headers = ["Name", "Email", "Organization", "Role", "Registered", "Sessions"];
    const rows = users.map((u) => [
      u.name,
      u.email,
      u.organization ?? "",
      u.role ?? "",
      new Date(u.createdAt).toLocaleDateString(),
      String(u.sessionCount),
    ]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `compost-heroes-users-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex-1">
          <input
            type="search"
            placeholder="Search by name, email, or organization…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-9 px-3 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
        </div>
        <button
          onClick={exportCsv}
          disabled={!users || users.length === 0}
          className="flex items-center gap-1.5 text-xs font-bold text-primary border-2 border-primary/30 rounded-xl px-3 h-9 hover:bg-primary/5 transition-colors disabled:opacity-40"
        >
          <Download className="w-3.5 h-3.5" /> Export CSV
        </button>
      </div>

      {isLoading && <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>}
      {error && <div className="text-center py-12 text-destructive"><AlertCircle className="w-8 h-8 mx-auto mb-2" /><p className="font-bold">Failed to load users</p></div>}

      {users && (
        <>
          <p className="text-xs text-muted-foreground mb-3">{users.length} registered user{users.length !== 1 ? "s" : ""}{search && ` · ${filtered.length} shown`}</p>
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="text-left text-xs font-bold text-muted-foreground uppercase tracking-wider px-4 py-2.5">Name</th>
                  <th className="text-left text-xs font-bold text-muted-foreground uppercase tracking-wider px-4 py-2.5">Email</th>
                  <th className="text-left text-xs font-bold text-muted-foreground uppercase tracking-wider px-4 py-2.5 hidden md:table-cell">Organization</th>
                  <th className="text-left text-xs font-bold text-muted-foreground uppercase tracking-wider px-4 py-2.5 hidden md:table-cell">Role</th>
                  <th className="text-left text-xs font-bold text-muted-foreground uppercase tracking-wider px-4 py-2.5">Joined</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={5} className="text-center py-10 text-muted-foreground text-sm">No users found</td></tr>
                ) : (
                  filtered.map((u, i) => (
                    <tr key={u.id} className={cn("border-b border-border last:border-0", i % 2 === 0 ? "bg-background" : "bg-muted/20")}>
                      <td className="px-4 py-3 font-semibold text-foreground whitespace-nowrap">{u.name}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{u.email}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs hidden md:table-cell">{u.organization ?? <span className="opacity-40">—</span>}</td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        {u.role ? (
                          <span className="text-[10px] font-bold bg-primary/10 text-primary border border-primary/20 rounded-full px-2 py-0.5">{u.role}</span>
                        ) : (
                          <span className="opacity-40 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">{new Date(u.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

// ── Main Admin page ───────────────────────────────────────────────────────────

export default function Admin() {
  const [, setLocation] = useLocation();
  const [adminKey, setAdminKey] = useState<string | null>(() => localStorage.getItem(ADMIN_KEY_STORAGE));
  const [validating, setValidating] = useState(!!adminKey);
  const [tab, setTab] = useState<"cards" | "users" | "analytics" | "games" | "backups">("users");

  useEffect(() => {
    if (!adminKey) return;
    let cancelled = false;
    setValidating(true);
    verifyAdminKey(adminKey)
      .then((ok) => {
        if (cancelled) return;
        if (!ok) {
          localStorage.removeItem(ADMIN_KEY_STORAGE);
          setAdminKey(null);
        }
        setValidating(false);
      })
      .catch(() => {
        if (!cancelled) setValidating(false);
      });
    return () => { cancelled = true; };
  }, []);

  if (validating) {
    return <div className="min-h-screen bg-background flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>;
  }

  if (!adminKey) {
    return <AdminPasswordGate onAuth={setAdminKey} />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="sticky top-0 z-10 bg-card/95 backdrop-blur border-b border-border px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center gap-4">
          <button onClick={() => setLocation("/")} className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <h1 className="font-display font-bold text-xl text-foreground">Admin Panel</h1>
          </div>
          <button
            onClick={() => { localStorage.removeItem(ADMIN_KEY_STORAGE); setAdminKey(null); }}
            className="text-xs text-muted-foreground hover:text-destructive transition-colors"
          >
            Sign out
          </button>
        </div>

        <div className="max-w-3xl mx-auto mt-3 flex gap-1 flex-wrap">
          <button
            onClick={() => setTab("users")}
            className={cn("flex items-center gap-1.5 text-sm font-bold px-4 py-2 rounded-xl transition-colors", tab === "users" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/50")}
          >
            <Users className="w-4 h-4" /> Users
          </button>
          <button
            onClick={() => setTab("cards")}
            className={cn("flex items-center gap-1.5 text-sm font-bold px-4 py-2 rounded-xl transition-colors", tab === "cards" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/50")}
          >
            <CreditCard className="w-4 h-4" /> Cards
          </button>
          <button
            onClick={() => setTab("analytics")}
            className={cn("flex items-center gap-1.5 text-sm font-bold px-4 py-2 rounded-xl transition-colors", tab === "analytics" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/50")}
          >
            <BarChart2 className="w-4 h-4" /> Analytics
          </button>
          <button
            onClick={() => setTab("games")}
            className={cn("flex items-center gap-1.5 text-sm font-bold px-4 py-2 rounded-xl transition-colors", tab === "games" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/50")}
          >
            <Gamepad2 className="w-4 h-4" /> Games
          </button>
          <button
            onClick={() => setTab("backups")}
            className={cn("flex items-center gap-1.5 text-sm font-bold px-4 py-2 rounded-xl transition-colors", tab === "backups" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/50")}
          >
            <Archive className="w-4 h-4" /> Backups
          </button>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-6">
        {tab === "users" && <UsersTab adminKey={adminKey} />}
        {tab === "cards" && <CardsTab adminKey={adminKey} />}
        {tab === "analytics" && <AnalyticsTab adminKey={adminKey} />}
        {tab === "games" && <GamesTab adminKey={adminKey} />}
        {tab === "backups" && <BackupsTab adminKey={adminKey} />}
      </div>
    </div>
  );
}
