export type ShareResult = "shared" | "copied" | "cancelled" | "failed";

interface ShareEnv {
  share?: (data: { title?: string; text?: string; url: string }) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
}

export async function shareInvite(url: string, env: ShareEnv): Promise<ShareResult> {
  if (env.share) {
    try {
      await env.share({ title: "Compost Heroes", text: "Join my Compost Heroes game", url });
      return "shared";
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return "cancelled";
      // other share errors fall through to copy
    }
  }
  try {
    if (!env.writeText) return "failed";
    await env.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}
