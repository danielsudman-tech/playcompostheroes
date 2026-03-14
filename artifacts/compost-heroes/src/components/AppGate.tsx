import { useState, useEffect, useCallback, type ReactNode } from "react";
import { Lock, Loader2 } from "lucide-react";

const STORAGE_KEY = "app_auth_password";

type Status = "loading" | "open" | "gated" | "verifying" | "authed";

export function AppGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const verify = useCallback(async (pw: string): Promise<boolean> => {
    const r = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    return r.ok;
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const r = await fetch("/api/auth/config");
        const config = await r.json() as { requiresPassword: boolean };

        if (cancelled) return;

        if (!config.requiresPassword) {
          setStatus("open");
          return;
        }

        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const ok = await verify(stored);
          if (cancelled) return;
          if (ok) {
            setStatus("authed");
            return;
          }
          localStorage.removeItem(STORAGE_KEY);
        }

        setStatus("gated");
      } catch {
        if (!cancelled) setStatus("gated");
      }
    })();

    return () => { cancelled = true; };
  }, [verify]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setStatus("verifying");
    setErrorMsg(null);
    try {
      const ok = await verify(password.trim());
      if (ok) {
        localStorage.setItem(STORAGE_KEY, password.trim());
        setStatus("authed");
      } else {
        setErrorMsg("Incorrect password");
        setStatus("gated");
      }
    } catch {
      setErrorMsg("Could not connect — please try again");
      setStatus("gated");
    }
  };

  if (status === "loading" || status === "verifying") {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    );
  }

  if (status === "open" || status === "authed") {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-background relative overflow-hidden flex flex-col items-center justify-center p-4">
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 blur-[100px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-secondary/20 blur-[120px] rounded-full pointer-events-none" />

      <div className="relative z-10 w-full max-w-sm">
        <div className="text-center mb-8">
          <img
            src={`${import.meta.env.BASE_URL}assets/card-back.jpg`}
            alt="Compost Heroes"
            className="w-36 mx-auto rounded-2xl shadow-2xl ring-4 ring-primary/20 mb-4"
            draggable={false}
          />
          <p className="text-muted-foreground">This app is password protected.</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-card/80 backdrop-blur-xl rounded-3xl shadow-xl border border-border p-6 space-y-4"
        >
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              placeholder="Enter password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setErrorMsg(null); }}
              className="w-full h-12 pl-9 pr-4 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>
          {errorMsg && (
            <p className="text-xs text-destructive text-center font-medium">{errorMsg}</p>
          )}
          <button
            type="submit"
            disabled={!password.trim() || status === "verifying"}
            className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-bold text-base hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Enter
          </button>
        </form>
      </div>
    </div>
  );
}
