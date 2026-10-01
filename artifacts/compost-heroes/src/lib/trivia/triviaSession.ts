import type { TriviaProgress, TriviaQuestion, TriviaStorage } from "./triviaTypes";

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
  return { ...progress, seenQuestionIds: [...progress.seenQuestionIds] };
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
      chosenChoice: null,
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
    if (!this.progress.currentQuestionId) this.selectNextQuestion();
    this.commit({ ...this.progress, open: true });
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

  choose(choice: number): void {
    const current = this.questions.get(this.progress.currentQuestionId ?? "");
    if (!current || this.progress.checked || !Number.isInteger(choice) ||
      choice < 0 || choice >= current.choices.length) return;
    this.commit({ ...this.progress, chosenChoice: choice });
  }

  check(): void {
    if (this.progress.checked || this.progress.chosenChoice === null) return;
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
    seen.add(currentQuestionId);
    this.seenQuestions.markSeen(currentQuestionId);
    this.commit({
      ...this.progress,
      currentQuestionId,
      chosenChoice: null,
      checked: false,
      seenQuestionIds: [...seen],
    });
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