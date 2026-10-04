import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getAllCards } from "../lib/cards.js";

const fact = "Manure from animals like chickens can rapidly spike nitrogen levels.";
assert.equal(getAllCards().find(card => card.id === "brown_bomber")?.factText, fact);
const trivia = readFileSync(new URL("../../../compost-heroes/src/lib/trivia/triviaQuestions.ts", import.meta.url), "utf8");
const question = trivia.match(/id: "manure-and-nitrogen"([\s\S]*?)\n  \},/)?.[1];
assert.ok(question, "Brown Bomber's matching trivia question exists");
assert.ok(question.includes(`sourceFact: "${fact}"`));
assert.ok(question.includes('question: "What can manure from animals like chickens do to nitrogen levels?"'));
assert.ok(!/herbivor/i.test(question), "chickens must not be described as herbivores");
console.log("brown-bomber-fact: card and trivia use the corrected animal fact");