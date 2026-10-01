/**
 * HTTP-route-level integration test: a facilitated Worm Party resolved by
 * multiple human seats must retain the original actor while the decision owner
 * changes, and announce the COMPLETED effect after all passes are applied.
 *
 * Mounts the real express app in-process on an ephemeral port.
 *
 * Run with: pnpm --filter @workspace/api-server run test:route-worm-party
 */
import assert from "node:assert/strict";
import app from "../app.js";
import { getGame, storeGame } from "../lib/gameStore.js";

const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/api`;

async function api(path: string, body?: unknown, method?: string) {
  const res = await fetch(`${base}${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as any;
  return { status: res.status, json };
}

try {
  // 1. Facilitated waiting room with two human participants and a spectator host.
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

  const started = await api(`/games/${gameId}/start`, {
    token: hostToken,
  });
  assert.equal(started.status, 200, JSON.stringify(started.json));

  // 2. Force Worm Party into Sally's hand and make it her play phase.
  let g = (await getGame(gameId))!;
  let worm = g.deck.find((c) => /worm party/i.test(c.name));
  if (!worm) {
    for (const p of g.players) {
      const hit = p.hand.find((c) => /worm party/i.test(c.name));
      if (hit) {
        worm = hit;
        p.hand = p.hand.filter((c) => c.id !== hit.id);
        break;
      }
    }
  } else {
    g = { ...g, deck: g.deck.filter((c) => c.id !== worm!.id) };
  }
  assert.ok(worm, "Worm Party must exist in the game");
  g.players[0].hand.push(worm!);
  g = { ...g, phase: "play", currentPlayerIndex: 0, actionPlayedThisTurn: false };
  await storeGame(g);

  // 3. Play Worm Party via the route → Sally's guided step must be pending.
  const played = await api(`/games/${gameId}/action`, {
    type: "play_card",
    playerId: "player_0",
    cardId: worm!.id,
    token: sallyToken,
  });
  assert.equal(played.status, 200, JSON.stringify(played.json));
  assert.ok(played.json.pendingDecision, "Sally's chain step must be pending");
  assert.equal(played.json.pendingDecision.playerId, "player_0");
  assert.equal((await getGame(gameId))?.pendingDecision?.meta?.originActorId, "player_0");
  const options = played.json.pendingDecision.options as Array<{ cardId: string }>;
  assert.ok(options.length > 0, "owner must see options via the route");

  // 4. Sally resolves; the next decision moves to Joe but keeps Sally as actor.
  const sallyResolved = await api(`/games/${gameId}/action`, {
    type: "resolve_decision",
    playerId: "player_0",
    decisionData: { cardId: options[0].cardId, cardIds: [options[0].cardId] },
    token: sallyToken,
  });
  assert.equal(sallyResolved.status, 200, JSON.stringify(sallyResolved.json));
  assert.equal(sallyResolved.json.pendingDecision?.playerId, "player_1");
  assert.equal((await getGame(gameId))?.pendingDecision?.meta?.originActorId, "player_0");
  const joeView = await api(`/games/${gameId}?token=${joeToken}`);
  const joeOptions = joeView.json.pendingDecision.options as Array<{ cardId: string }>;
  assert.ok(joeOptions.length > 0, "Joe must see his own Worm Party options");

  // Joe completes the chain; the final announcement must still credit Sally.
  const resolved = await api(`/games/${gameId}/action`, {
    type: "resolve_decision",
    playerId: "player_1",
    decisionData: { cardId: joeOptions[0].cardId, cardIds: [joeOptions[0].cardId] },
    token: joeToken,
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.json));
  assert.equal(resolved.json.pendingDecision, null, "both human steps must complete the chain");

  // 5. The FINAL announcement must describe the completed Worm Party effect.
  const fx = resolved.json.lastEffect;
  assert.ok(fx, "final response must carry an effect announcement");
  assert.match(fx.cardName, /worm party/i, `announcement must name Worm Party, got "${fx.cardName}"`);
  assert.equal(fx.playedById, "player_0");
  assert.equal(fx.playedByName, "Sally");
  assert.ok(
    (fx.outcome as string[]).some((l) => /cards passed/i.test(l)),
    `outcome must describe the completed pass, got: ${JSON.stringify(fx.outcome)}`
  );
  assert.ok(fx.events.some((event: any) =>
    event.fact?.actorId === "player_0" && event.fact?.playerIds?.includes("player_1")
  ), "Joe's participation must be described under Sally's effect");

  console.log("route-worm-party.test.ts: all assertions passed ✔");
} finally {
  server.close();
  process.exit(0);
}
