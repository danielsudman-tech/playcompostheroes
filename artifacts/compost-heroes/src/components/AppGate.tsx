import { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from "react";
import { Loader2, User, Mail, Building2, ChevronDown, Leaf, Lock, Eye, EyeOff } from "lucide-react";
import compostHeroesLogo from "@assets/Compost_Heroes_Logo_no_background_1773537933517.png";
import greenCampsLogo from "@assets/Green_Camps_Logo_no_background_1773537933517.png";

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
}

const UserContext = createContext<UserContextValue>({ user: null });

export function useCurrentUser(): RegisteredUser | null {
  return useContext(UserContext).user;
}

type Status = "loading" | "registered" | "idle" | "submitting";
type Mode = "signin" | "register";

const ROLES = [
  { value: "", label: "Select your role (optional)" },
  { value: "Teacher", label: "Teacher / Educator" },
  { value: "Student", label: "Student" },
  { value: "Facilitator", label: "Program Facilitator" },
  { value: "Parent", label: "Parent / Guardian" },
  { value: "Other", label: "Other" },
];

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

export function AppGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<RegisteredUser | null>(null);
  const [mode, setMode] = useState<Mode>("signin");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Sign-in fields
  const [siEmail, setSiEmail] = useState("");
  const [siPassword, setSiPassword] = useState("");

  // Register fields
  const [regName, setRegName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirm, setRegConfirm] = useState("");
  const [regOrg, setRegOrg] = useState("");
  const [regRole, setRegRole] = useState("");

  const validateToken = useCallback(async (token: string): Promise<RegisteredUser | null> => {
    try {
      const r = await fetch(`/api/auth/me?token=${encodeURIComponent(token)}`);
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

  function switchMode(m: Mode) {
    setMode(m);
    setErrorMsg(null);
  }

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("submitting");
    setErrorMsg(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: siEmail.trim(), password: siPassword }),
      });
      const data = await r.json() as { token?: string; user?: RegisteredUser; error?: string };
      if (!r.ok || !data.token || !data.user) {
        setErrorMsg(data.error ?? "Sign in failed, please try again");
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

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (regPassword !== regConfirm) {
      setErrorMsg("Passwords do not match");
      return;
    }
    if (regPassword.length < 6) {
      setErrorMsg("Password must be at least 6 characters");
      return;
    }
    setStatus("submitting");
    setErrorMsg(null);
    try {
      const r = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: regName.trim(),
          email: regEmail.trim(),
          password: regPassword,
          organization: regOrg.trim() || undefined,
          role: regRole || undefined,
        }),
      });
      const data = await r.json() as { token?: string; user?: RegisteredUser; error?: string };
      if (!r.ok || !data.token || !data.user) {
        setErrorMsg(data.error ?? "Registration failed, please try again");
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

  if (status === "loading" || status === "submitting") {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <img src={compostHeroesLogo} alt="Compost Heroes" className="w-48 opacity-80" draggable={false} />
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (status === "registered") {
    return <UserContext.Provider value={{ user }}>{children}</UserContext.Provider>;
  }

  return (
    <div className="min-h-screen bg-background relative overflow-hidden flex flex-col items-center justify-center p-4">
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 blur-[100px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-secondary/20 blur-[120px] rounded-full pointer-events-none" />

      <div className="relative z-10 w-full max-w-sm">
        <div className="text-center mb-6">
          <img
            src={compostHeroesLogo}
            alt="Compost Heroes"
            className="w-56 mx-auto mb-3 drop-shadow-xl"
            draggable={false}
          />
        </div>

        <div className="bg-card/80 backdrop-blur-xl rounded-3xl shadow-xl border border-border overflow-hidden">
          {/* Tab bar */}
          <div className="flex border-b border-border">
            <button
              type="button"
              onClick={() => switchMode("signin")}
              className={`flex-1 py-3 text-sm font-bold transition-colors ${
                mode === "signin"
                  ? "bg-primary/10 text-primary border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => switchMode("register")}
              className={`flex-1 py-3 text-sm font-bold transition-colors ${
                mode === "register"
                  ? "bg-primary/10 text-primary border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Register
            </button>
          </div>

          {/* Sign In form */}
          {mode === "signin" && (
            <form onSubmit={handleSignIn} className="p-6 space-y-4">
              <p className="text-sm text-muted-foreground text-center">Welcome back, hero!</p>

              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
                <input
                  type="email"
                  autoFocus
                  autoComplete="email"
                  placeholder="Email address"
                  value={siEmail}
                  onChange={(e) => { setSiEmail(e.target.value); setErrorMsg(null); }}
                  className="w-full h-12 pl-9 pr-4 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                  required
                />
              </div>

              <PasswordInput
                value={siPassword}
                onChange={(v) => { setSiPassword(v); setErrorMsg(null); }}
                placeholder="Password"
                autoComplete="current-password"
              />

              {errorMsg && (
                <p className="text-xs text-destructive text-center font-medium">{errorMsg}</p>
              )}

              <button
                type="submit"
                disabled={!siEmail.trim() || !siPassword}
                className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-bold text-base hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Sign In
              </button>

              <p className="text-center text-xs text-muted-foreground">
                New here?{" "}
                <button type="button" onClick={() => switchMode("register")} className="text-primary font-semibold hover:underline">
                  Create an account
                </button>
              </p>
            </form>
          )}

          {/* Register form */}
          {mode === "register" && (
            <form onSubmit={handleRegister} className="p-6 space-y-4">
              <p className="text-sm text-muted-foreground text-center">Join the composting adventure!</p>

              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
                <input
                  type="text"
                  autoFocus
                  autoComplete="name"
                  placeholder="Your name *"
                  value={regName}
                  onChange={(e) => { setRegName(e.target.value); setErrorMsg(null); }}
                  className="w-full h-12 pl-9 pr-4 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                  required
                />
              </div>

              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
                <input
                  type="email"
                  autoComplete="email"
                  placeholder="Email address *"
                  value={regEmail}
                  onChange={(e) => { setRegEmail(e.target.value); setErrorMsg(null); }}
                  className="w-full h-12 pl-9 pr-4 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                  required
                />
              </div>

              <PasswordInput
                value={regPassword}
                onChange={(v) => { setRegPassword(v); setErrorMsg(null); }}
                placeholder="Choose a password *"
                autoComplete="new-password"
              />

              <PasswordInput
                value={regConfirm}
                onChange={(v) => { setRegConfirm(v); setErrorMsg(null); }}
                placeholder="Confirm password *"
                autoComplete="new-password"
              />

              <div className="relative">
                <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
                <input
                  type="text"
                  autoComplete="organization"
                  placeholder="School / Organization (optional)"
                  value={regOrg}
                  onChange={(e) => setRegOrg(e.target.value)}
                  className="w-full h-12 pl-9 pr-4 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                />
              </div>

              <div className="relative">
                <Leaf className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
                <select
                  value={regRole}
                  onChange={(e) => setRegRole(e.target.value)}
                  className="w-full h-12 pl-9 pr-8 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary appearance-none"
                >
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>

              {errorMsg && (
                <p className="text-xs text-destructive text-center font-medium">{errorMsg}</p>
              )}

              <button
                type="submit"
                disabled={!regName.trim() || !regEmail.trim() || !regPassword || !regConfirm}
                className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-bold text-base hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create Account
              </button>

              <p className="text-center text-xs text-muted-foreground">
                Already have an account?{" "}
                <button type="button" onClick={() => switchMode("signin")} className="text-primary font-semibold hover:underline">
                  Sign in
                </button>
              </p>
            </form>
          )}
        </div>

        <div className="flex items-center justify-center gap-2 mt-5 opacity-60">
          <span className="text-xs text-muted-foreground">A Project of</span>
          <img src={greenCampsLogo} alt="Green Camps" className="h-6 object-contain" draggable={false} />
        </div>
      </div>
    </div>
  );
}
