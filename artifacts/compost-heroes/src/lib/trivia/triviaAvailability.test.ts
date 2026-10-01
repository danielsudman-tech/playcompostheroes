import assert from "node:assert/strict";
import test from "node:test";
import {
  canOpenTrivia,
  isFacilitatedEventTriviaEnabled,
  isFacilitatedGameTriviaEnabled,
} from "./triviaAvailability";

test("Facilitated trivia remains on for old or not-yet-loaded Event settings", () => {
  assert.equal(isFacilitatedEventTriviaEnabled(undefined), true);
  assert.equal(isFacilitatedEventTriviaEnabled(null), true);
  assert.equal(isFacilitatedEventTriviaEnabled({}), true);
  assert.equal(isFacilitatedEventTriviaEnabled({ triviaEnabled: true }), true);
  assert.equal(isFacilitatedEventTriviaEnabled({ triviaEnabled: "false" }), true);
});

test("only an explicit Event triviaEnabled false disables trivia", () => {
  assert.equal(isFacilitatedEventTriviaEnabled({ triviaEnabled: false }), false);
});

test("Facilitated game snapshots take precedence over Event trivia settings", () => {
  assert.equal(isFacilitatedGameTriviaEnabled({ triviaEnabled: false }, { triviaEnabled: true }), false);
  assert.equal(isFacilitatedGameTriviaEnabled({ triviaEnabled: true }, { triviaEnabled: false }), true);
});

test("older game snapshots fall back to Event metadata, defaulting on when absent", () => {
  assert.equal(isFacilitatedGameTriviaEnabled({}, { triviaEnabled: false }), false);
  assert.equal(isFacilitatedGameTriviaEnabled({}, { triviaEnabled: true }), true);
  assert.equal(isFacilitatedGameTriviaEnabled({}, undefined), true);
});

test("a waiting player can open inline trivia until their turn or any required choice", () => {
  const waiting = {
    enabled: true,
    waiting: true,
    requiredDecision: false,
    handoffActive: false,
  };

  assert.equal(canOpenTrivia(waiting, "waiting"), true);
  assert.equal(canOpenTrivia({ ...waiting, waiting: false }, "waiting"), false);
  assert.equal(canOpenTrivia({ ...waiting, requiredDecision: true }, "waiting"), false);
  assert.equal(canOpenTrivia({ ...waiting, enabled: false }, "waiting"), false);
});

test("Pass & Play group trivia is available only inside an active handoff", () => {
  const handoff = {
    enabled: true,
    waiting: false,
    requiredDecision: false,
    handoffActive: false,
  };

  assert.equal(canOpenTrivia(handoff, "handoff"), false);
  assert.equal(canOpenTrivia({ ...handoff, handoffActive: true }, "handoff"), true);
  assert.equal(canOpenTrivia({ ...handoff, handoffActive: true, requiredDecision: true }, "handoff"), false);
});