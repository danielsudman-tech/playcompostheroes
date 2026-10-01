export interface TriviaQuestion {
  id: string;
  cardId: string;
  question: string;
  choices: readonly string[];
  correctChoice: number;
  sourceFact: string;
  explanation: string;
}

export interface TriviaProgress {
  sessionKey: string;
  open: boolean;
  currentQuestionId: string | null;
  /** Stable identity for the selected option; presentation order may change. */
  chosenChoiceId: string | null;
  /** Canonical option indices in this presentation's shuffled order. */
  choiceOrder: number[];
  checked: boolean;
  seenQuestionIds: string[];
}

/** An option ID is stable across shuffles of the same question. */
export function triviaOptionId(questionId: string, canonicalIndex: number): string {
  return `${questionId}:option:${canonicalIndex}`;
}

export function isCorrectTriviaOption(question: TriviaQuestion, optionId: string): boolean {
  return optionId === triviaOptionId(question.id, question.correctChoice);
}

export interface TriviaStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TriviaAvailability {
  enabled: boolean;
  waiting: boolean;
  requiredDecision: boolean;
  handoffActive: boolean;
}

export type TriviaMode = "waiting" | "handoff";