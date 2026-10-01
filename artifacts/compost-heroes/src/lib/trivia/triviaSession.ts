import { triviaOptionId, type TriviaProgress, type TriviaQuestion, type TriviaStorage } from "./triviaTypes";

export const TRIVIA_STORAGE_KEY = "compost-heroes.trivia.seen.v1";
const memorySeenByStorageKey = new Map<string, Set<string>>();

/** Local storage is a convenience, never a prerequisite for playing trivia. */
export class SeenQuestionRepository {
  private readonly memorySeen: Set<string>;

  constructor(
    private readonly storage?: TriviaStorage | null,
    private readonly storageKey = TRIVIA_STORAGE_KEY,
  ) {
    this.memorySeen = memorySeenByStorageKey.get(storageKey) ?? new Set<string>();
    memorySeenByStorageKey.set(storageKey, this.memorySeen);
  }

  getSeenIds(): string[] {
    let stored: unknown = [];
    try {
      const raw = this.storage?.getItem(this.storageKey);
      stored = raw ? JSON.parse(raw) : [];
    } catch {
      // Some browsers and privacy modes block storage access entirely.
    }
    if (Array.isArray(stored)) {
      for (const id of stored) {
        if (typeof id === "string" && id.length > 0) this.memorySeen.add(id);
      }
    }
    return [...this.memorySeen];
  }

  markSeen(id: string): void {
    if (!id) return;
    this.memorySeen.add(id);
    try {
      this.storage?.setItem(this.storageKey, JSON.stringify([...this.memorySeen]));
    } catch {
      // Retain this session's progress in memory if persistent storage is denied.
    }
  }
}

export function readBrowserTriviaStorage(): TriviaStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function copyProgress(progress: TriviaProgress): TriviaProgress {
  return {
    ...progress,
    choiceOrder: [...progress.choiceOrder],
    seenQuestionIds: [...progress.seenQuestionIds],
  };
}

export class TriviaSessionController {
  private listeners = new Set<() => void>();
  private questions = new Map<string, TriviaQuestion>();
  private questionIds: string[] = [];
  private progress: TriviaProgress;

  constructor(
    readonly sessionKey: string,
    private readonly seenQuestions = new SeenQuestionRepository(readBrowserTriviaStorage()),
    private readonly random: () => number = Math.random,
  ) {
    this.progress = {
      sessionKey,
      open: false,
      currentQuestionId: null,
      chosenChoiceId: null,
      choiceOrder: [],
      checked: false,
      seenQuestionIds: this.seenQuestions.getSeenIds(),
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TriviaProgress => this.progress;

  getQuestions = (): readonly TriviaQuestion[] =>
    this.questionIds.flatMap((id) => {
      const question = this.questions.get(id);
      return question ? [question] : [];
    });

  setQuestions(questions: readonly TriviaQuestion[]): void {
    this.questions = new Map(questions.map((question) => [question.id, question]));
    this.questionIds = questions.map((question) => question.id);
  }

  open(): void {
    if (this.progress.open) return;
    if (!this.progress.currentQuestionId) {
      this.selectNextQuestion();
      this.commit({ ...this.progress, open: true });
      return;
    }

    const question = this.currentQuestion();
    this.commit({
      ...this.progress,
      choiceOrder: question
        ? this.shuffleChoiceOrder(question.choices.length)
        : this.progress.choiceOrder,
      open: true,
    });
  }

  close(): void {
    if (!this.progress.open) return;
    this.commit({ ...this.progress, open: false });
  }

  /**
   * Keep the question and answer in memory but hide the optional panel as soon
   * as a turn or required choice makes the player active.
   */
  syncAvailability(available: boolean, requiredDecision: boolean): void {
    if (!available || requiredDecision) this.close();
  }

  choose(choiceId: string): void {
    const current = this.questions.get(this.progress.currentQuestionId ?? "");
    if (!current || this.progress.checked ||
      !this.progress.choiceOrder.some((index) => triviaOptionId(current.id, index) === choiceId)) return;
    this.commit({ ...this.progress, chosenChoiceId: choiceId });
  }

  check(): void {
    if (this.progress.checked || this.progress.chosenChoiceId === null) return;
    this.commit({ ...this.progress, checked: true });
  }

  next(): void {
    this.selectNextQuestion();
  }

  currentQuestion(): TriviaQuestion | null {
    return this.questions.get(this.progress.currentQuestionId ?? "") ?? null;
  }

  private selectNextQuestion(): void {
    if (this.questionIds.length === 0) return;
    let seen = new Set(this.progress.seenQuestionIds);
    let unseen = this.questionIds.filter((id) => !seen.has(id));

    // Once the local question set has cycled through once, it can begin again.
    if (unseen.length === 0) {
      seen = new Set();
      unseen = [...this.questionIds];
    }
    const index = Math.min(unseen.length - 1, Math.floor(this.random() * unseen.length));
    const currentQuestionId = unseen[index];
    const currentQuestion = this.questions.get(currentQuestionId);
    const choiceOrder = currentQuestion
      ? this.shuffleChoiceOrder(currentQuestion.choices.length)
      : [];
    seen.add(currentQuestionId);
    this.seenQuestions.markSeen(currentQuestionId);
    this.commit({
      ...this.progress,
      currentQuestionId,
      chosenChoiceId: null,
      choiceOrder,
      checked: false,
      seenQuestionIds: [...seen],
    });
  }

  private shuffleChoiceOrder(length: number): number[] {
    const order = Array.from({ length }, (_, index) => index);
    // Fisher–Yates creates one presentation order when a question is selected.
    // The order then lives in progress until another question is selected.
    for (let index = order.length - 1; index > 0; index--) {
      const randomIndex = Math.max(0, Math.min(index, Math.floor(this.random() * (index + 1))));
      [order[index], order[randomIndex]] = [order[randomIndex], order[index]];
    }
    return order;
  }

  private commit(progress: TriviaProgress): void {
    this.progress = copyProgress(progress);
    for (const listener of this.listeners) listener();
  }
}

const sessions = new Map<string, TriviaSessionController>();
const MAX_IN_MEMORY_SESSIONS = 32;

/** Reuse the seat's session while its panel is closed or auto-hidden. */
export function getTriviaSession(
  sessionKey: string,
  storage = readBrowserTriviaStorage(),
): TriviaSessionController {
  const existing = sessions.get(sessionKey);
  if (existing) {
    sessions.delete(sessionKey);
    sessions.set(sessionKey, existing);
    return existing;
  }
  const session = new TriviaSessionController(
    sessionKey,
    new SeenQuestionRepository(storage),
  );
  sessions.set(sessionKey, session);
  if (sessions.size > MAX_IN_MEMORY_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
  return session;
}

export function resetTriviaSessionsForTests(): void {
  sessions.clear();
}