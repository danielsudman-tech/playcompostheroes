import assert from "node:assert/strict";
import { COMPOST_ASSESSMENT_URL, POST_GAME_LINKS } from "./links";

assert.equal(COMPOST_ASSESSMENT_URL, "https://start.compostheroes.org/");
assert.equal(
  POST_GAME_LINKS.find(link => link.id === "assessment")?.href,
  "https://start.compostheroes.org/",
  "Shared post-game links must use the correct Compost Heroes assessment",
);

console.log("links.test.ts: post-game compost assessment destination passed");
