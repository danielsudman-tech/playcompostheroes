/**
 * HTTP-route-level regression test: facilitated Soggy Pile with a human
 * decision owner who has MULTIPLE eligible discards must get a guided
 * `choose_soggy_pile_discard` decision whose options submit `cardId`, and the
 * chain must complete through the route pipeline (bots auto-resolving theirs).
 *
 * Run with: pnpm --filter @workspace/api-server run test:route-soggy-pile
 */
import assert from "node:assert/strict";
import app from "../app.js";
import { getGame, storeGame } from "../lib/gameStore.js";

const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/api`;

async function api(path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

try {
  const created = await api("/games", { mode: "facilitated", hostName: "Maria", maxPlayers: 3 });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const gameId = created.json.gameId as string;
  const token = created.json.creatorToken as string;

  const started = await api(`/games/${gameId}/start`, {
    token,
    botSlots: [{ name: "RoboBen" }, { name: "RoboZoe" }],
  });
  assert.equal(started.status, 200, JSON.stringify(started.json));

  // Seed: Soggy Pile into Maria's hand; give Maria TWO eligible pile cards
  // (Moisture + Nitrogen) so she must actively choose; give a bot one too.
  let g = (await getGame(gameId))!;
  const takeFromDeck = (pred: (c: any) => boolean) => {
    const idx = g.deck.findIndex(pred);
    assert.ok(idx >= 0, "needed card not found in deck");
    const c = g.deck[idx];
    g = { ...g, deck: g.deck.filter((_, i) => i !== idx) };
    return c;
  };
  const soggy = takeFromDeck((c) => c.baseId === "soggy_pile" || /soggy pile/i.test(c.name));
  const moisture = takeFromDeck((c) => c.type === "hero" && c.function === "Moisture");
  const nitrogen = takeFromDeck((c) => c.type === "hero" && c.function === "Nitrogen");
  const botNitrogen = takeFromDeck((c) => c.type === "hero" && c.function === "Nitrogen");

  g.players[0].hand.push(soggy);
  g.players[0].compostPile.push(moisture, nitrogen);
  g.players[1].compostPile.push(botNitrogen);
  g = { ...g, phase: "play", currentPlayerIndex: 0, actionPlayedThisTurn: false };
  await storeGame(g);

  // Play Soggy Pile → the human (2 candidates) must get a guided decision.
  const played = await api(`/games/${gameId}/action`, {
    type: "play_card",
    playerId: "player_0",
    cardId: soggy.id,
    token,
  });
  assert.equal(played.status, 200, JSON.stringify(played.json));
  const d = played.json.pendingDecision;
  assert.ok(d, "human must get a guided Soggy Pile decision");
  assert.equal(d.type, "choose_soggy_pile_discard");
  assert.equal(d.playerId, "player_0");
  const opts = d.options as Array<{ cardId: string; cardName: string }>;
  assert.equal(opts.length, 2, "both eligible pile cards must be offered");
  assert.ok(opts.every((o) => o.cardId && o.cardName), "options must carry cardId for the modal");

  // Human resolves by cardId (exactly what DecisionModal card selection submits).
  const pick = opts.find((o) => o.cardId === nitrogen.id)!;
  const resolved = await api(`/games/${gameId}/action`, {
    type: "resolve_decision",
    playerId: "player_0",
    decisionData: { cardId: pick.cardId },
    token,
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.json));
  assert.equal(resolved.json.pendingDecision, null, "chain must drain (bot had a single candidate → auto)");

  // Human's explicit choice honored; announcement describes the completed effect.
  const maria = resolved.json.players[0];
  assert.ok(!maria.compostPile.some((c: any) => c.id === nitrogen.id), "chosen card must be discarded");
  assert.ok(maria.compostPile.some((c: any) => c.id === moisture.id), "unchosen card must remain");
  const fx = resolved.json.lastEffect;
  assert.ok(fx, "final response must carry an effect announcement");
  assert.match(fx.cardName, /soggy pile/i, `announcement must name Soggy Pile, got "${fx.cardName}"`);

  console.log("route-soggy-pile.test.ts: all assertions passed ✔");
} finally {
  server.close();
  process.exit(0);
}
