import type { TriviaQuestion } from "./triviaTypes";

/**
 * Load the small, versioned question bundle from the app's own static assets.
 * User actions after this resolves only update local component/memory state.
 */
let questionsPromise: Promise<readonly TriviaQuestion[]> | null = null;

export function loadTriviaQuestions(): Promise<readonly TriviaQuestion[]> {
  if (!questionsPromise) {
    questionsPromise = import("./triviaQuestions")
      .then((bundle) => bundle.triviaQuestions)
      .catch((error: unknown) => {
        questionsPromise = null;
        throw error;
      });
  }
  return questionsPromise;
}