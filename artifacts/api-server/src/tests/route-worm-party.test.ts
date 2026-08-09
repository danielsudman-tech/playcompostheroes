/**
 * HTTP-route-level integration test: a facilitated human + bots Worm Party
 * completed through the /action route pipeline (including runBotTurnsIfNeeded)
 * must return/broadcast a final `lastEffect` describing the COMPLETED effect
 * (Worm Party with all passes applied) — not the human's intermediate step.
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
  // 1. Facilitated waiting room, human host + two bots added at start.
  const created = await api("/games", { mode: "facilitated", hostName: "Maria", maxPlayers: 3 });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const gameId = created.json.gameId as string;
  const token = created.json.creatorToken as string;

  const started = await api(`/games/${gameId}/start`, {
    token,
    botSlots: [{ name: "RoboBen" }, { name: "RoboZoe" }],
  });
  assert.equal(started.status, 200, JSON.stringify(started.json));

  // 2. Force Worm Party into Maria's hand and make it her play phase.
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

  // 3. Play Worm Party via the route → human's guided step must be pending.
  const played = await api(`/games/${gameId}/action`, {
    type: "play_card",
    playerId: "player_0",
    cardId: worm!.id,
    token,
  });
  assert.equal(played.status, 200, JSON.stringify(played.json));
  assert.ok(played.json.pendingDecision, "human's chain step must be pending");
  assert.equal(played.json.pendingDecision.playerId, "player_0");
  const options = played.json.pendingDecision.options as Array<{ cardId: string }>;
  assert.ok(options.length > 0, "owner must see options via the route");

  // 4. Human resolves; bots complete their chain steps inside the route.
  const resolved = await api(`/games/${gameId}/action`, {
    type: "resolve_decision",
    playerId: "player_0",
    decisionData: { cardId: options[0].cardId, cardIds: [options[0].cardId] },
    token,
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.json));
  assert.equal(resolved.json.pendingDecision, null, "bot steps must drain in the route pipeline");

  // 5. The FINAL announcement must describe the completed Worm Party effect.
  const fx = resolved.json.lastEffect;
  assert.ok(fx, "final response must carry an effect announcement");
  assert.match(fx.cardName, /worm party/i, `announcement must name Worm Party, got "${fx.cardName}"`);
  assert.ok(
    (fx.outcome as string[]).some((l) => /cards passed/i.test(l)),
    `outcome must describe the completed pass, got: ${JSON.stringify(fx.outcome)}`
  );

  console.log("route-worm-party.test.ts: all assertions passed ✔");
} finally {
  server.close();
  process.exit(0);
}
