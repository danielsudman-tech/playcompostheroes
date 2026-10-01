import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { BookOpen, Check, ChevronRight, Lightbulb, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { useTriviaSession } from "@/hooks/use-trivia-session";

type TriviaSessionView = ReturnType<typeof useTriviaSession>;

function TriviaChoices({ session }: { session: TriviaSessionView }) {
  const question = session.currentQuestion;
  if (!question) {
    return (
      <div role="status" className="rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">
        Loading a question…
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-4 text-left shadow-lg">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-primary">
          <BookOpen className="h-4 w-4" /> Compost trivia
        </p>
        <button
          type="button"
          onClick={session.close}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label="Close compost trivia"
          data-testid="button-trivia-close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <h2 className="mb-4 text-base font-bold leading-snug text-foreground">{question.question}</h2>

      <fieldset disabled={session.progress.checked} className="space-y-2">
        <legend className="sr-only">Choose one answer</legend>
        {question.choices.map((choice, index) => {
          const isSelected = session.progress.chosenChoice === index;
          const isCorrect = session.progress.checked && index === question.correctChoice;
          const isIncorrectSelection = session.progress.checked && isSelected && !isCorrect;
          return (
            <label
              key={`${question.id}-${index}`}
              className={`flex min-h-10 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm transition-colors focus-within:ring-2 focus-within:ring-primary ${
                isCorrect
                  ? "border-primary bg-primary/10 font-semibold"
                  : isIncorrectSelection
                    ? "border-amber-500 bg-amber-500/10"
                    : isSelected
                      ? "border-primary/60 bg-primary/5"
                      : "border-border hover:bg-muted/60"
              }`}
            >
              <input
                type="radio"
                name={`trivia-${question.id}`}
                value={index}
                checked={isSelected}
                onChange={() => session.choose(index)}
                className="h-4 w-4 accent-primary"
              />
              <span className="flex-1">{choice}</span>
              {isCorrect && <Check className="h-4 w-4 text-primary" aria-label="Correct answer" />}
            </label>
          );
        })}
      </fieldset>

      {session.progress.checked && (
        <div className="mt-3 flex gap-2 rounded-xl bg-primary/5 p-3 text-sm leading-relaxed text-foreground" role="status">
          <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p>
            <strong className="mr-1">
              {session.progress.chosenChoice === question.correctChoice ? "Nice finding." : "Here’s the answer."}
            </strong>
            {question.explanation}
          </p>
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        {session.progress.checked ? (
          <Button type="button" onClick={session.next} size="sm">
            Another question <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        ) : (
          <Button
            type="button"
            onClick={session.check}
            disabled={session.progress.chosenChoice === null}
            size="sm"
          >
            Check answer
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Render the actual optional quiz once in the table. Online/Facilitated gets a
 * non-blocking user-opened dialog; Pass & Play keeps trivia inside its opaque
 * handoff and never substitutes for the explicit Reveal action.
 */
export function TriviaPanel({
  session,
  mode,
  onHandoffFocusFallback,
}: {
  session: TriviaSessionView;
  mode: "waiting" | "handoff";
  onHandoffFocusFallback?: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const handoffLauncherRef = useRef<HTMLButtonElement>(null);
  const handoffPanelRef = useRef<HTMLDivElement>(null);
  const wasHandoffVisible = useRef(false);

  useEffect(() => {
    if (mode !== "waiting" || !session.isVisible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        session.close();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const items = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex="0"]:not([aria-hidden="true"])',
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [session.isVisible, session.close, mode]);

  useEffect(() => {
    if (mode !== "handoff") return;
    const wasVisible = wasHandoffVisible.current;
    wasHandoffVisible.current = session.isAvailable && session.isVisible;
    if (!wasVisible && session.isVisible) {
      handoffPanelRef.current
        ?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])')
        ?.focus();
    } else if (wasVisible && !session.isVisible) {
      if (session.isAvailable && handoffLauncherRef.current) {
        handoffLauncherRef.current.focus();
      } else {
        onHandoffFocusFallback?.();
      }
    }
  }, [mode, session.isAvailable, session.isVisible, onHandoffFocusFallback]);

  if (mode === "handoff") {
    if (!session.isAvailable) return null;
    if (!session.isVisible) {
      return (
        <div ref={handoffPanelRef} className="mt-4 flex flex-col items-center gap-2">
          <button
            type="button"
            ref={handoffLauncherRef}
            onClick={() => { void session.open(); }}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="Try a compost question together while switching players"
            data-testid="button-handoff-trivia"
          >
            <BookOpen className="h-4 w-4 shrink-0 text-primary" />
            Try a group compost question
          </button>
          {session.loadError && (
            <p role="status" className="text-xs text-destructive">{session.loadError}</p>
          )}
        </div>
      );
    }
    return (
      <div ref={handoffPanelRef}>
        <TriviaChoices session={session} />
      </div>
    );
  }

  if (!session.isVisible || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[180] flex items-center justify-center overflow-y-auto bg-black/50 p-3 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Learn while you wait"
        tabIndex={-1}
        className="my-auto w-full max-w-md rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary"
        data-testid="trivia-dialog"
      >
        <TriviaChoices session={session} />
      </div>
    </div>,
    document.body,
  );
}

/** A small launch control that fits in either desktop Game Updates or the mobile strip. */
export function TriviaLauncher({
  session,
  compact = false,
}: {
  session: TriviaSessionView;
  compact?: boolean;
}) {
  if (!session.isAvailable || session.isVisible) return null;
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => { void session.open(); }}
        className={compact
          ? "inline-flex min-h-8 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          : "inline-flex min-h-10 items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-left text-sm font-semibold text-foreground transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"}
        aria-label="Learn while you wait with a compost question"
        data-testid="button-learn-while-wait"
      >
        <BookOpen className="h-4 w-4 shrink-0 text-primary" />
        <span>{compact ? "Learn" : "Learn while you wait"}</span>
      </button>
      {session.loadError && (
        <p role="status" className="text-xs text-destructive">{session.loadError}</p>
      )}
    </div>
  );
}