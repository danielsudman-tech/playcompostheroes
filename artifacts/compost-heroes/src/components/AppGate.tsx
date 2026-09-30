import { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from "react";
import { useLocation as useWouterLocation } from "wouter";
import { Loader2, Lock, Eye, EyeOff, HelpCircle, X } from "lucide-react";
import compostHeroesLogo from "@assets/Compost_Heroes_Logo_no_background_1773537933517.png";
import { PHYSICAL_GAME_URL } from "@/lib/links";

const STORAGE_KEY = "compost_user_token";

export interface RegisteredUser {
  id: string;
  email: string;
  name: string;
  organization?: string | null;
  role?: string | null;
}

interface UserContextValue {
  user: RegisteredUser | null;
  logout: () => void;
}

const UserContext = createContext<UserContextValue>({ user: null, logout: () => {} });

export function useCurrentUser(): RegisteredUser | null {
  return useContext(UserContext).user;
}

export function useLogout(): () => void {
  return useContext(UserContext).logout;
}

type Status = "loading" | "registered" | "idle" | "submitting";
type Mode = "start" | "signin";

function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoComplete?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
      <input
        type={show ? "text" : "password"}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-12 pl-9 pr-10 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
        required
        minLength={6}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-muted-foreground"
        tabIndex={-1}
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

// Registration rules:
// - The lobby ("/") is open to everyone — guests can set up Pass & Play.
// - Facilitated game routes (table/host) are open — players just enter a
//   name at the table, no account needed.
// - Pass & Play and facilitated games at /game/:id are open; online games
//   require sign-in (checked per-game via the API below).
function isUngatedPath(p: string): boolean {
  return p === "/" || /^\/event\/[^/]+(?:\/results)?\/?$/.test(p) || /^\/game\/[^/]+\/(table|host)\/?$/.test(p);
}

function pathGameId(p: string): string | null {
  const m = p.match(/^\/game\/([^/]+)\/?$/);
  return m ? m[1] : null;
}

export function AppGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<RegisteredUser | null>(null);
  const [mode, setMode] = useState<Mode>(() =>
    new URLSearchParams(window.location.search).has("signin") || /\/facilitator(?:\/|$)/.test(window.location.pathname)
      ? "signin"
      : "start"
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showForgot, setShowForgot] = useState(false);

  // ?signin=1 forces the gate UI even on ungated paths (used by the lobby's
  // "Sign in to play online" button).
  const [forceGate, setForceGate] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).has("signin");
    } catch {
      return false;
    }
  });

  // For /game/:id — only online games require an account. Recomputed on
  // every client-side navigation via wouter's location hook.
  const [location] = useWouterLocation();
  const gameId = pathGameId(location);
  const [gameNeedsGate, setGameNeedsGate] = useState<boolean | null>(gameId ? null : false);
  useEffect(() => {
    if (!gameId) {
      setGameNeedsGate(false);
      return;
    }
    setGameNeedsGate(null);
    let cancelled = false;
    fetch(`/api/games/${encodeURIComponent(gameId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { mode?: string } | null) => {
        if (!cancelled) setGameNeedsGate((d?.mode ?? "online") === "online");
      })
      .catch(() => {
        if (!cancelled) setGameNeedsGate(true);
      });
    return () => {
      cancelled = true;
    };
  }, [gameId]);

  const validateToken = useCallback(async (token: string): Promise<RegisteredUser | null> => {
    try {
      const r = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return null;
      const data = await r.json() as { user: RegisteredUser };
      return data.user;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const validUser = await validateToken(stored);
        if (cancelled) return;
        if (validUser) {
          setUser(validUser);
          setStatus("registered");
          return;
        }
        localStorage.removeItem(STORAGE_KEY);
      }
      if (!cancelled) setStatus("idle");
    })();
    return () => { cancelled = true; };
  }, [validateToken]);

  // An administrator may approve a facilitator in another tab while this
  // lobby remains open. Refresh their role when they return to this tab.
  useEffect(() => {
    const refreshUser = async () => {
      const token = localStorage.getItem(STORAGE_KEY);
      if (!token) return;
      const updated = await validateToken(token);
      if (updated && localStorage.getItem(STORAGE_KEY) === token) setUser(updated);
    };
    window.addEventListener("focus", refreshUser);
    return () => window.removeEventListener("focus", refreshUser);
  }, [validateToken]);

  // Once signed in via a forced gate, clean the ?signin param from the URL.
  useEffect(() => {
    if (status !== "registered" || !forceGate) return;
    try {
      const params = new URLSearchParams(window.location.search);
      params.delete("signin");
      const qs = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
    } catch {}
    setForceGate(false);
  }, [status, forceGate]);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
    setStatus("idle");
    setMode("start");
    setEmail("");
    setPassword("");
    setName("");
    setConfirmPassword("");
    setErrorMsg(null);
  }, []);

  function switchMode(m: Mode) {
    setMode(m);
    setErrorMsg(null);
    setShowForgot(false);
  }

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!email.trim() || !password) return;

    setStatus("submitting");

    if (mode === "signin") {
      try {
        const r = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim(), password }),
        });
        const data = await r.json() as { token?: string; user?: RegisteredUser; error?: string };
        if (!r.ok || !data.token || !data.user) {
          setErrorMsg(data.error ?? "Sign in failed — check your email and password");
          setStatus("idle");
          return;
        }
        localStorage.setItem(STORAGE_KEY, data.token);
        setUser(data.user);
        setStatus("registered");
      } catch {
        setErrorMsg("Could not connect — please try again");
        setStatus("idle");
      }
      return;
    }

    if (!name.trim()) {
      setErrorMsg("Please enter your name");
      setStatus("idle");
      return;
    }
    if (password !== confirmPassword) {
      setErrorMsg("Passwords don't match");
      setStatus("idle");
      return;
    }
    if (password.length < 6) {
      setErrorMsg("Password must be at least 6 characters");
      setStatus("idle");
      return;
    }

    try {
      const r = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password }),
      });
      const data = await r.json() as { token?: string; user?: RegisteredUser; error?: string };
      if (!r.ok || !data.token || !data.user) {
        setErrorMsg(data.error ?? "Registration failed — please try again");
        setStatus("idle");
        return;
      }
      localStorage.setItem(STORAGE_KEY, data.token);
      setUser(data.user);
      setStatus("registered");
    } catch {
      setErrorMsg("Could not connect — please try again");
      setStatus("idle");
    }
  };

  if (status === "registered") {
    return <UserContext.Provider value={{ user, logout }}>{children}</UserContext.Provider>;
  }

  if (!forceGate) {
    if (isUngatedPath(location)) {
      return <UserContext.Provider value={{ user, logout }}>{children}</UserContext.Provider>;
    }
    if (gameId && gameNeedsGate === false) {
      return <UserContext.Provider value={{ user, logout }}>{children}</UserContext.Provider>;
    }
  }

  if (status === "loading" || status === "submitting" || (!forceGate && gameId && gameNeedsGate === null)) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <img src={compostHeroesLogo} alt="Compost Heroes" className="w-48 opacity-80" draggable={false} />
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background relative overflow-hidden flex flex-col items-center justify-start md:justify-center p-4 py-10">
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 blur-[100px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-secondary/20 blur-[120px] rounded-full pointer-events-none" />
      <div className="relative z-10 w-full max-w-md flex flex-col gap-8">

        {/* Hero section */}
        <div className="text-center space-y-4">
          <img
            src={compostHeroesLogo}
            alt="Compost Heroes"
            className="w-56 mx-auto drop-shadow-xl"
            draggable={false}
          />
          <div className="space-y-2">
            <h1 className="text-2xl md:text-3xl font-extrabold text-foreground leading-tight">
              Food Waste is Winning.<br />
              <span className="text-primary">Are You Ready to Fight Back?</span>
            </h1>
            <p className="text-muted-foreground text-sm md:text-base leading-relaxed max-w-sm mx-auto">
              Play Compost Heroes — a fast-paced strategy game where you build a compost system and battle food waste.
            </p>
          </div>

        </div>

        {/* Auth card */}
        <div className="bg-card/80 backdrop-blur-xl rounded-3xl shadow-xl border border-border overflow-hidden">

          <div className="px-6 pt-5 pb-2">
            <h2 className="text-lg font-bold text-foreground text-center">{mode === "signin" ? "Sign in" : "Create an account"}</h2>
            <p className="text-xs text-muted-foreground text-center mt-1">
              {mode === "signin" ? "Use your account to play online or host approved sessions." : "Create your account to play online. No spam."}
            </p>
          </div>

          <form onSubmit={handleStart} className="p-6 pt-4 space-y-3">

            {mode === "start" && (
              <input
                type="text"
                autoFocus
                autoComplete="name"
                placeholder="Your name"
                value={name}
                onChange={(e) => { setName(e.target.value); setErrorMsg(null); }}
                className="w-full h-12 px-4 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                required
              />
            )}

            <input
              type="email"
              autoFocus={mode === "signin"}
              autoComplete="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setErrorMsg(null); }}
              className="w-full h-12 px-4 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
              required
            />

            <PasswordInput
              value={password}
              onChange={(v) => { setPassword(v); setErrorMsg(null); }}
              placeholder={mode === "start" ? "Choose a password" : "Password"}
              autoComplete={mode === "start" ? "new-password" : "current-password"}
            />

            {mode === "start" && (
              <PasswordInput
                value={confirmPassword}
                onChange={(v) => { setConfirmPassword(v); setErrorMsg(null); }}
                placeholder="Confirm password"
                autoComplete="new-password"
              />
            )}

            {/* Forgot password — only shown in signin mode */}
            {mode === "signin" && (
              <div className="text-right -mt-1">
                <button
                  type="button"
                  onClick={() => setShowForgot((s) => !s)}
                  className="text-xs text-muted-foreground hover:text-primary transition-colors flex items-center gap-1 ml-auto"
                >
                  <HelpCircle className="w-3.5 h-3.5" />
                  Forgot your password?
                </button>
              </div>
            )}

            {showForgot && mode === "signin" && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex gap-3 items-start">
                <HelpCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-amber-900 mb-0.5">Password reset needed?</p>
                  <p className="text-xs text-amber-800 leading-relaxed">
                    Contact your game admin and ask them to reset your password. They can do this from the admin panel.
                  </p>
                </div>
                <button type="button" onClick={() => setShowForgot(false)} className="text-amber-500 hover:text-amber-700 shrink-0 mt-0.5">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {errorMsg && (
              <p className="text-xs text-destructive text-center font-medium">{errorMsg}</p>
            )}

            <button
              type="submit"
              disabled={!email.trim() || !password || (mode === "start" && (!name.trim() || !confirmPassword))}
              className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-bold text-base hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {mode === "signin" ? "Sign in" : "Create account"}
            </button>

            <p className="text-center text-xs text-muted-foreground">
              {mode === "start" ? (
                <>Already have an account?{" "}
                  <button type="button" onClick={() => switchMode("signin")} className="text-primary font-semibold hover:underline">
                    Sign in
                  </button>
                </>
              ) : (
                <>New here?{" "}
                  <button type="button" onClick={() => switchMode("start")} className="text-primary font-semibold hover:underline">
                    Create a free account
                  </button>
                </>
              )}
            </p>
          </form>

          {/* Trust signals */}
          <div className="border-t border-border px-6 py-4 bg-muted/30">
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <span className="text-primary font-bold">✔</span> No downloads
              </span>
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <span className="text-primary font-bold">✔</span> Play in your browser
              </span>
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <span className="text-primary font-bold">✔</span> Designed for camps, schools & teams
              </span>
            </div>
          </div>
        </div>

        {/* Green Camps footer */}
        <div className="text-center space-y-1">
          <p className="text-sm font-semibold text-foreground/70">Built by Green Camps</p>
          <p className="text-xs text-muted-foreground">Turning sustainability into action through play</p>
        </div>

        {/* Purchase link */}
        <div className="text-center">
          <a
            href={PHYSICAL_GAME_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-full px-4 py-2 text-sm font-semibold transition-colors shadow-sm"
          >
            Prefer the physical version? Buy the deck →
          </a>
        </div>

      </div>
    </div>
  );
}
