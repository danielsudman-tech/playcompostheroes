import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { loadTriviaQuestions } from "@/lib/trivia/loadTriviaQuestions";
import { getTriviaSession, type TriviaSessionController } from "@/lib/trivia/triviaSession";
import { canOpenTrivia } from "@/lib/trivia/triviaAvailability";
import type { TriviaAvailability, TriviaMode } from "@/lib/trivia/triviaTypes";

export function useTriviaSession({
  sessionKey,
  mode,
  enabled,
  waiting,
  requiredDecision,
  handoffActive,
}: {
  /** Use a game-and-seat key online; use a game-and-current-turn key at handoff. */
  sessionKey: string;
  mode: TriviaMode;
  enabled: boolean;
  waiting: boolean;
  requiredDecision: boolean;
  handoffActive: boolean;
}) {
  const controller = getTriviaSession(sessionKey);
  const progress = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [questions, setQuestions] = useState(controller.getQuestions());
  const [loadError, setLoadError] = useState<string | null>(null);
  const availability: TriviaAvailability = { enabled, waiting, requiredDecision, handoffActive };
  const availabilityRef = useRef(availability);
  availabilityRef.current = availability;

  const available = canOpenTrivia(availability, mode);
  const progressForSession = progress.sessionKey === sessionKey ? progress : controller.getSnapshot();

  useEffect(() => {
    controller.syncAvailability(available, requiredDecision);
  }, [controller, available, requiredDecision]);

  useEffect(() => {
    setQuestions(controller.getQuestions());
  }, [controller, sessionKey]);

  const close = useCallback(() => controller.close(), [controller]);
  const choose = useCallback((choiceId: string) => controller.choose(choiceId), [controller]);
  const check = useCallback(() => controller.check(), [controller]);
  const next = useCallback(() => controller.next(), [controller]);

  const open = useCallback(async () => {
    const current = availabilityRef.current;
    if (!canOpenTrivia(current, mode)) return;

    let bundle;
    try {
      bundle = await loadTriviaQuestions();
    } catch {
      setLoadError("Trivia could not be loaded. You can keep playing without it.");
      return;
    }
    if (!canOpenTrivia(availabilityRef.current, mode)) return;
    controller.setQuestions(bundle);
    setQuestions(controller.getQuestions());
    controller.open();
    setLoadError(null);
  }, [controller, mode]);

  return {
    progress: progressForSession,
    questions,
    currentQuestion: controller.currentQuestion(),
    loadError,
    isAvailable: available,
    isVisible: progressForSession.open && available,
    open,
    close,
    choose,
    check,
    next,
  };
}