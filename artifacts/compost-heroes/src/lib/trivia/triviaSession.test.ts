import assert from "node:assert/strict";
import test from "node:test";
import { triviaQuestions } from "./triviaQuestions";
import {
  SeenQuestionRepository,
  TriviaSessionController,
  TRIVIA_STORAGE_KEY,
  resetTriviaSessionsForTests,
} from "./triviaSession";
import { getTriviaSession } from "./triviaSession";

const expectedCardIds = [
  "fresh_air_friend", "branch_buddy", "biochar", "major_brown",
  "stink_shield", "mycelial_alchemist", "under_web", "actinomycetes",
  "hot_head", "old_timer", "captain_nectar", "hydro_hauler",
  "slumber_soaker", "microbial_marshal", "brown_bomber", "anaerobic_tyrant",
  "legion_of_life", "nitrogen_boost", "anaerobic_pocket", "carbon_sink",
  "dry_spell", "critter_raid", "pile_flip", "rot_roulette",
];

test("the question bundle contains 24 unique sourced questions with plain explanations", () => {
  assert.equal(triviaQuestions.length, 24);
  assert.equal(new Set(triviaQuestions.map((question) => question.id)).size, triviaQuestions.length);
  assert.deepEqual(triviaQuestions.map((question) => question.cardId), expectedCardIds);

  for (const question of triviaQuestions) {
    assert.equal(question.choices.length, 3, `${question.id} has three choices`);
    assert.ok(question.correctChoice >= 0 && question.correctChoice < question.choices.length);
    assert.ok(question.sourceFact.length > 25, `${question.id} retains its card fact text`);
    assert.ok(question.explanation.length <= 145, `${question.id} has a short explanation`);
    assert.doesNotMatch(question.explanation, /\b(should|must|fault|blame)\b/i);
  }
});

test("choosing, checking, explaining, and navigating the local bundle makes no network calls", () => {
  const originalFetch = globalThis.fetch;
  const originalXHR = (globalThis as unknown as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("Trivia progress must not make HTTP requests");
  }) as typeof fetch;
  class TrackedXMLHttpRequest {
    open(): void { networkCalls += 1; }
    send(): void { networkCalls += 1; }
    setRequestHeader(): void { networkCalls += 1; }
  }
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = TrackedXMLHttpRequest;

  try {
    const storage = new Map<string, string>();
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    };
    let choiceNumber = 0;
    const controller = new TriviaSessionController(
      "network-free-answers",
      new SeenQuestionRepository(adapter, `${TRIVIA_STORAGE_KEY}.network-test`),
      () => choiceNumber++ / 100,
    );

    controller.setQuestions(triviaQuestions);
    controller.open();
    for (let index = 0; index < 5; index++) {
      const question = controller.currentQuestion();
      assert.ok(question);
      controller.choose(question.correctChoice);
      controller.check();
      assert.equal(controller.getSnapshot().checked, true);
      assert.ok(question.explanation);
      controller.next();
    }
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalXHR === undefined) {
      delete (globalThis as unknown as { XMLHttpRequest?: unknown }).XMLHttpRequest;
    } else {
      (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = originalXHR;
    }
  }
});

test("storage denial falls back to an in-memory seen-question record", () => {
  const deniedStorage = {
    getItem(): string { throw new Error("Storage access denied"); },
    setItem(): void { throw new Error("Storage quota/access denied"); },
  };
  const repository = new SeenQuestionRepository(deniedStorage, "denied-storage-test");

  assert.deepEqual(repository.getSeenIds(), []);
  assert.doesNotThrow(() => repository.markSeen("air-question"));
  assert.deepEqual(repository.getSeenIds(), ["air-question"]);
});

test("seen questions resume from browser storage in a fresh session", () => {
  const values = new Map<string, string>();
  const adapter = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const storageKey = "persisted-seen-question-test";
  const first = new TriviaSessionController(
    "first-tab",
    new SeenQuestionRepository(adapter, storageKey),
    () => 0,
  );
  first.setQuestions(triviaQuestions);
  first.open();
  const firstQuestionId = first.currentQuestion()?.id;

  const restored = new TriviaSessionController(
    "restored-tab",
    new SeenQuestionRepository(adapter, storageKey),
    () => 0,
  );
  restored.setQuestions(triviaQuestions);
  restored.open();

  assert.ok(firstQuestionId);
  assert.notEqual(restored.currentQuestion()?.id, firstQuestionId);
  assert.ok(restored.getSnapshot().seenQuestionIds.includes(firstQuestionId));
});

test("question selection remembers seen questions and cycles without immediately repeating", () => {
  const controller = new TriviaSessionController(
    "cycles-through-bundle",
    new SeenQuestionRepository(null, "cycle-test"),
    () => 0,
  );
  controller.setQuestions(triviaQuestions);
  controller.open();
  const first = controller.currentQuestion()?.id;
  controller.next();
  const second = controller.currentQuestion()?.id;

  assert.ok(first);
  assert.ok(second);
  assert.notEqual(second, first);
  assert.ok(controller.getSnapshot().seenQuestionIds.includes(first));
  assert.ok(controller.getSnapshot().seenQuestionIds.includes(second));
  for (let index = 0; index < triviaQuestions.length - 2; index++) controller.next();
  assert.equal(controller.getSnapshot().seenQuestionIds.length, triviaQuestions.length);
  controller.next();
  assert.equal(controller.currentQuestion()?.id, triviaQuestions[0].id);
  assert.equal(controller.getSnapshot().seenQuestionIds.length, 1);
});

test("closing for a turn or a required choice keeps the question, answer, and explanation place", () => {
  const controller = new TriviaSessionController(
    "auto-close-progress",
    new SeenQuestionRepository(null, "auto-close-test"),
    () => 0,
  );
  controller.setQuestions(triviaQuestions);
  controller.open();

  const question = controller.currentQuestion();
  assert.ok(question);
  const answeredChoice = question.correctChoice;
  controller.choose(answeredChoice);
  controller.check();
  controller.syncAvailability(false, false);
  assert.equal(controller.getSnapshot().open, false);
  assert.equal(controller.getSnapshot().currentQuestionId, question.id);
  assert.equal(controller.getSnapshot().chosenChoice, answeredChoice);
  assert.equal(controller.getSnapshot().checked, true);

  controller.open();
  controller.syncAvailability(true, true);
  assert.equal(controller.getSnapshot().open, false);
  assert.equal(controller.getSnapshot().currentQuestionId, question.id);
  assert.equal(controller.getSnapshot().chosenChoice, answeredChoice);
  assert.equal(controller.getSnapshot().checked, true);
});

test("a closed panel reuses its game-and-seat session", () => {
  resetTriviaSessionsForTests();
  const first = getTriviaSession("game-one:seat-one", null);
  const second = getTriviaSession("game-one:seat-two", null);
  assert.notEqual(first, second);
  first.setQuestions(triviaQuestions);
  first.open();
  first.close();
  assert.equal(getTriviaSession("game-one:seat-one", null).getSnapshot().currentQuestionId,
    first.getSnapshot().currentQuestionId);
});