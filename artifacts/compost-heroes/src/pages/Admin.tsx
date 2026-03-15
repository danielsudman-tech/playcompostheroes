import { useState, useRef, useCallback, useEffect } from "react";
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
  const [tab, setTab] = useState<"cards" | "users">("users");

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

        <div className="max-w-3xl mx-auto mt-3 flex gap-1">
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
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-6">
        {tab === "users" && <UsersTab adminKey={adminKey} />}
        {tab === "cards" && <CardsTab adminKey={adminKey} />}
      </div>
    </div>
  );
}
