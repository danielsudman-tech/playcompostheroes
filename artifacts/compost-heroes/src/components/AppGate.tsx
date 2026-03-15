import { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from "react";
import { Loader2, User, Mail, Building2, ChevronDown, Leaf } from "lucide-react";
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

type Status = "loading" | "registered" | "unregistered" | "submitting";

const ROLES = [
  { value: "", label: "Select your role (optional)" },
  { value: "Teacher", label: "Teacher / Educator" },
  { value: "Student", label: "Student" },
  { value: "Facilitator", label: "Program Facilitator" },
  { value: "Parent", label: "Parent / Guardian" },
  { value: "Other", label: "Other" },
];

export function AppGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<RegisteredUser | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [organization, setOrganization] = useState("");
  const [role, setRole] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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
      if (!cancelled) setStatus("unregistered");
    })();
    return () => { cancelled = true; };
  }, [validateToken]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    setStatus("submitting");
    setErrorMsg(null);
    try {
      const r = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          organization: organization.trim() || undefined,
          role: role || undefined,
        }),
      });
      const data = await r.json() as { token?: string; user?: RegisteredUser; error?: string };
      if (!r.ok || !data.token || !data.user) {
        setErrorMsg(data.error ?? "Something went wrong, please try again");
        setStatus("unregistered");
        return;
      }
      localStorage.setItem(STORAGE_KEY, data.token);
      setUser(data.user);
      setStatus("registered");
    } catch {
      setErrorMsg("Could not connect — please try again");
      setStatus("unregistered");
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
          <p className="text-foreground font-semibold text-lg">Create a free account to play</p>
          <p className="text-muted-foreground text-sm mt-1">Join the composting adventure!</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-card/80 backdrop-blur-xl rounded-3xl shadow-xl border border-border p-6 space-y-4"
        >
          <div className="relative">
            <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
            <input
              type="text"
              autoFocus
              autoComplete="name"
              placeholder="Your name *"
              value={name}
              onChange={(e) => { setName(e.target.value); setErrorMsg(null); }}
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
              value={email}
              onChange={(e) => { setEmail(e.target.value); setErrorMsg(null); }}
              className="w-full h-12 pl-9 pr-4 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
              required
            />
          </div>

          <div className="relative">
            <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
            <input
              type="text"
              autoComplete="organization"
              placeholder="School / Organization (optional)"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              className="w-full h-12 pl-9 pr-4 rounded-xl border-2 border-border bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>

          <div className="relative">
            <Leaf className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
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
            disabled={!name.trim() || !email.trim()}
            className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-bold text-base hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Let's Play!
          </button>

          <p className="text-center text-xs text-muted-foreground">
            Already registered? Enter your email and name again to sign back in.
          </p>
        </form>

        <div className="flex items-center justify-center gap-2 mt-5 opacity-60">
          <span className="text-xs text-muted-foreground">A Project of</span>
          <img src={greenCampsLogo} alt="Green Camps" className="h-6 object-contain" draggable={false} />
        </div>
      </div>
    </div>
  );
}
