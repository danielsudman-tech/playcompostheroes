/**
 * HTTP-route-level regression test: facilitated Soggy Pile with a different
 * human actor and decision owner. Joe has MULTIPLE eligible discards and must get a guided
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
  const created = await api("/games", { mode: "facilitated", hostName: "Host", maxPlayers: 2 });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const gameId = created.json.gameId as string;
  const hostToken = created.json.creatorToken as string;

  const joinedSally = await api(`/games/${gameId}/join`, { name: "Sally" });
  assert.equal(joinedSally.status, 201, JSON.stringify(joinedSally.json));
  const sallyToken = joinedSally.json.token as string;
  const joinedJoe = await api(`/games/${gameId}/join`, { name: "Joe" });
  assert.equal(joinedJoe.status, 201, JSON.stringify(joinedJoe.json));
  const joeToken = joinedJoe.json.token as string;

  const started = await api(`/games/${gameId}/start`, { token: hostToken });
  assert.equal(started.status, 200, JSON.stringify(started.json));

  // Seed: Sally plays Soggy Pile with one eligible compost card, so she is
  // handled automatically. Joe has two eligible cards and must choose.
  let g = (await getGame(gameId))!;
  const takeFromDeck = (pred: (c: any) => boolean) => {
    const idx = g.deck.findIndex(pred);
    assert.ok(idx >= 0, "needed card not found in deck");
    const c = g.deck[idx];
    g = { ...g, deck: g.deck.filter((_, i) => i !== idx) };
    return c;
  };
  const soggy = takeFromDeck((c) => c.baseId === "soggy_pile" || /soggy pile/i.test(c.name));
  const sallyMoisture = takeFromDeck((c) => c.type === "hero" && c.function === "Moisture");
  const joeMoisture = takeFromDeck((c) => c.type === "hero" && c.function === "Moisture");
  const joeNitrogen = takeFromDeck((c) => c.type === "hero" && c.function === "Nitrogen");

  g.players[0].hand.push(soggy);
  g.players[0].compostPile.push(sallyMoisture);
  g.players[1].compostPile.push(joeMoisture, joeNitrogen);
  g = { ...g, phase: "play", currentPlayerIndex: 0, actionPlayedThisTurn: false };
  await storeGame(g);

  // Play Soggy Pile → the human (2 candidates) must get a guided decision.
  const played = await api(`/games/${gameId}/action`, {
    type: "play_card",
    playerId: "player_0",
    cardId: soggy.id,
    token: sallyToken,
  });
  assert.equal(played.status, 200, JSON.stringify(played.json));
  assert.ok(played.json.pendingDecision, "Joe must get a guided Soggy Pile decision");
  const pendingGame = (await getGame(gameId))!;
  assert.equal(pendingGame.pendingDecision?.meta?.originActorId, "player_0");
  // Simulate a saved pre-origin-metadata decision: currentPlayerIndex is still
  // Sally while the decision is pending and is the safe legacy actor fallback.
  const legacyMeta = { ...pendingGame.pendingDecision!.meta };
  delete legacyMeta.originActorId;
  delete legacyMeta.originVerb;
  await storeGame({
    ...pendingGame,
    pendingDecision: { ...pendingGame.pendingDecision!, meta: legacyMeta },
  });
  const joeView = await api(`/games/${gameId}?token=${joeToken}`);
  const d = joeView.json.pendingDecision;
  assert.ok(d, "Joe must see the active decision");
  assert.equal(d.type, "choose_soggy_pile_discard");
  assert.equal(d.playerId, "player_1");
  assert.equal(d.meta?.originActorId, undefined, "origin actor is server-only in the wire response");
  const opts = d.options as Array<{ cardId: string; cardName: string }>;
  assert.equal(opts.length, 2, "both eligible pile cards must be offered");
  assert.ok(opts.every((o) => o.cardId && o.cardName), "options must carry cardId for the modal");

  // Joe resolves by cardId (exactly what DecisionModal card selection submits).
  const pick = opts.find((o) => o.cardId === joeNitrogen.id)!;
  const resolved = await api(`/games/${gameId}/action`, {
    type: "resolve_decision",
    playerId: "player_1",
    decisionData: { cardId: pick.cardId },
    token: joeToken,
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.json));
  assert.equal(resolved.json.pendingDecision, null, "chain must drain (bot had a single candidate → auto)");

  // Joe's explicit choice is applied and attributed to Sally, the actual actor.
  const joe = resolved.json.players[1];
  assert.ok(!joe.compostPile.some((c: any) => c.id === joeNitrogen.id), "chosen card must be discarded");
  assert.ok(joe.compostPile.some((c: any) => c.id === joeMoisture.id), "unchosen card must remain");
  const fx = resolved.json.lastEffect;
  assert.ok(fx, "final response must carry an effect announcement");
  assert.match(fx.cardName, /soggy pile/i, `announcement must name Soggy Pile, got "${fx.cardName}"`);
  assert.equal(fx.playedById, "player_0");
  assert.equal(fx.playedByName, "Sally");
  assert.ok(fx.events.some((event: any) =>
    event.fact?.kind === "pile_loss" &&
    event.fact.actorId === "player_0" &&
    event.fact.playerIds.includes("player_1")
  ), "Joe's pile loss must be attributed to Sally as the effect actor");

  // Also exercise an activated effect through its multi-step decision chain:
  // the original actor remains Sally after the pending decisions advance.
  let activationState = (await getGame(gameId))!;
  g = activationState;
  const rotRegrow = takeFromDeck((c) => c.baseId === "rot_regrow" || /rot & regrow/i.test(c.name));
  activationState = {
    ...g,
    ongoingActionCard: rotRegrow,
    phase: "play",
    currentPlayerIndex: 0,
    ongoingBenefitUsedThisTurn: false,
  };
  assert.ok(activationState.players[0].hand.length >= 3);
  await storeGame(activationState);
  const activated = await api(`/games/${gameId}/action`, {
    type: "activate_ongoing",
    playerId: "player_0",
    token: sallyToken,
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.json));
  assert.equal((await getGame(gameId))?.pendingDecision?.meta?.originActorId, "player_0");
  assert.equal(activated.json.lastEffect?.verb, "activated");
  const discardOptions = activated.json.pendingDecision.options as Array<{ cardId: string }>;
  const discarded = await api(`/games/${gameId}/action`, {
    type: "resolve_decision",
    playerId: "player_0",
    decisionData: { cardIds: discardOptions.slice(0, 3).map((option) => option.cardId) },
    token: sallyToken,
  });
  assert.equal(discarded.status, 200, JSON.stringify(discarded.json));
  assert.equal(discarded.json.pendingDecision?.type, "choose_rot_regrow_take");
  assert.equal((await getGame(gameId))?.pendingDecision?.meta?.originActorId, "player_0");
  assert.equal(discarded.json.lastEffect?.playedById, "player_0");
  assert.equal(discarded.json.lastEffect?.verb, "activated");
  const takeOptions = discarded.json.pendingDecision.options as Array<{ cardId: string }>;
  assert.ok(takeOptions.length > 0);
  const completedActivation = await api(`/games/${gameId}/action`, {
    type: "resolve_decision",
    playerId: "player_0",
    decisionData: { cardId: takeOptions[0].cardId },
    token: sallyToken,
  });
  assert.equal(completedActivation.status, 200, JSON.stringify(completedActivation.json));
  assert.equal(completedActivation.json.lastEffect?.playedById, "player_0");
  assert.equal(completedActivation.json.lastEffect?.playedByName, "Sally");
  assert.equal(completedActivation.json.lastEffect?.verb, "activated");

  console.log("route-soggy-pile.test.ts: all assertions passed ✔");
} finally {
  server.close();
  process.exit(0);
}
