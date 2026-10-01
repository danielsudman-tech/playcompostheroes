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
  chosenChoice: number | null;
  checked: boolean;
  seenQuestionIds: string[];
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