import assert from "node:assert/strict";
import { getGetGameQueryKey } from "@workspace/api-client-react";
import { QueryClient } from "@tanstack/react-query";
import { shouldRetireClaim, nextClaimIdentity, shouldAttemptClaim, createViewerGuard, gameStateKey, viewerFingerprint, VIEWER_ID_LIMIT } from "./gameCache";
import { addUpdate, effectSignature, noticeUpdate, scopeKey, turnNoticeFor, updateFromEffect } from "./gameUpdates";

const a = gameStateKey("g1", "tokenA"), b = gameStateKey("g1", "tokenB");
assert.notDeepEqual(a, b);
assert.notDeepEqual(gameStateKey("g1", null), gameStateKey("g2", null));
assert.ok(!JSON.stringify(a).includes("tokenA"));
assert.deepEqual(a.slice(0, 1), getGetGameQueryKey("g1"));
assert.equal(viewerFingerprint(null), "anon");
// same-length / FNV-style colliding-shaped tokens stay distinct and stable
const same = ["aaaaaaaa", "aaaaaaab", "baaaaaaa"].map(viewerFingerprint);
assert.equal(new Set(same).size, 3);
assert.equal(viewerFingerprint("aaaaaaaa"), same[0]);
for (const f of same) assert.ok(!/aaaa/.test(f));


// seat switch: late GET / cached private effect for seat A never lands in seat B's entry
const qc = new QueryClient();
qc.setQueryData(a, { lastEffect: { privateEvents: ["secret A"] } });
assert.equal(qc.getQueryData(b), undefined);
const guard = createViewerGuard();
const genA = guard.begin("g1", "tokenA");
const genB = guard.begin("g1", "tokenB");
assert.equal(guard.isCurrent(genA, "g1", "tokenA"), false);
assert.equal(guard.isCurrent(genB, "g1", "tokenB"), true);
// mutation context key captured at mutate time
const ctxKey = gameStateKey("g1", "tokenA");
qc.setQueryData(ctxKey, { v: 1 });
assert.deepEqual(qc.getQueryData(a), { v: 1 });
assert.equal(qc.getQueryData(b), undefined);
// prefix invalidation reaches all viewers
qc.setQueryData(b, { v: 2 });
await qc.invalidateQueries({ queryKey: getGetGameQueryKey("g1") });
assert.equal(qc.getQueryState(a)?.isInvalidated, true);
assert.equal(qc.getQueryState(b)?.isInvalidated, true);

// same effect id, changed private payload refreshes entry
const eff = { id: "e", cardId: "c", cardName: "X", cardText: "", imageKey: null, playedById: "p", playedByName: "P", outcome: [], events: [], privateEvents: ["one"] };
let list = addUpdate([], updateFromEffect(eff, "p", 5));
list = addUpdate(list, updateFromEffect({ ...eff, privateEvents: ["one", "two"] }, "p", 9));
assert.equal(list.length, 1);
assert.deepEqual(list[0].lines, ["one", "two"]);
assert.equal(list[0].at, 5);

// turn notices dedupe by game+seat+turn
const scope = { gameId: "g1", seatId: "s1" };
const t = turnNoticeFor(scope, { turnNumber: 4, currentPlayerId: "s1", phase: "draw" }, 0)!;
assert.equal(addUpdate(addUpdate([], t), turnNoticeFor(scope, { turnNumber: 4, currentPlayerId: "s1", phase: "play" }, 1)!).length, 1);
assert.equal(turnNoticeFor(scope, { turnNumber: 4, currentPlayerId: "s2", phase: "draw" }, 0), null);
assert.notEqual(t.id, turnNoticeFor({ gameId: "g1", seatId: "s2" }, { turnNumber: 4, currentPlayerId: "s2", phase: "draw" }, 0)!.id);
void noticeUpdate;

// source guards: use-game.ts has no unscoped game-state writes
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../hooks/use-game.ts", import.meta.url), "utf8");
assert.ok(!/setQueryData\(getGetGameQueryKey/.test(src));
assert.ok(!/queryKey: gameId \? getGetGameQueryKey/.test(src));
assert.ok(/new EventSource/.test(src) && /let active = true/.test(src));
// bounded map: ids are never reused after pruning
const first = viewerFingerprint("prune-0");
const seen = new Set<string>([first]);
for (let i = 1; i < VIEWER_ID_LIMIT + 20; i++) seen.add(viewerFingerprint(`prune-${i}`));
assert.equal(seen.size, VIEWER_ID_LIMIT + 20);
assert.notEqual(viewerFingerprint("prune-0"), first);
assert.ok(!seen.has(viewerFingerprint("prune-0")));
// viewer scope: same game+seat, different credential differs
const sA = { gameId: "g1", seatId: "s1", viewerId: viewerFingerprint("credA") };
const sB = { gameId: "g1", seatId: "s1", viewerId: viewerFingerprint("credB") };
assert.notEqual(scopeKey(sA), scopeKey(sB));
assert.notEqual(turnNoticeFor(sA, { turnNumber: 2, currentPlayerId: "s1", phase: "draw" }, 0)!.id, turnNoticeFor(sB, { turnNumber: 2, currentPlayerId: "s1", phase: "draw" }, 0)!.id);
// turn: waiting/game_over null; draw -> play same turn logs once
assert.equal(turnNoticeFor(sA, { turnNumber: 0, currentPlayerId: "s1", phase: "waiting" }, 0), null);
assert.equal(turnNoticeFor(sA, { turnNumber: 9, currentPlayerId: "s1", phase: "game_over" }, 0), null);
let tl = addUpdate([], turnNoticeFor(sA, { turnNumber: 1, currentPlayerId: "s1", phase: "draw" }, 0)!);
tl = addUpdate(tl, turnNoticeFor(sA, { turnNumber: 1, currentPlayerId: "s1", phase: "play" }, 1)!);
assert.equal(tl.length, 1);
// corrected private payload under same effect id refreshes the record
const e2 = { id: "e9", cardId: "c", cardName: "X", cardText: "", imageKey: null, playedById: "p", playedByName: "P", outcome: [], events: [], privateEvents: ["old"] };
let l2 = addUpdate([], updateFromEffect(e2 as any, "p", 1));
l2 = addUpdate(l2, updateFromEffect({ ...e2, privateEvents: ["fixed"] } as any, "p", 2));
assert.equal(l2.length, 1);
assert.ok(l2[0].lines!.includes("fixed") && !l2[0].lines!.includes("old"));
assert.notEqual(effectSignature(e2 as any), effectSignature({ ...e2, privateEvents: ["fixed"] } as any));
// claim race: A in flight, URL effect stores B -> new generation, B must claim
let id = nextClaimIdentity({ gameId: null, viewer: null, generation: 0 }, "g1", "A");
assert.equal(id.generation, 1);
assert.equal(shouldAttemptClaim(null, id, true), true);
const attempted = id.generation; // A's claim started
const idB = nextClaimIdentity(id, "g1", "B");
assert.equal(idB.generation, 2); // A's response is now obsolete
assert.equal(shouldAttemptClaim(attempted, idB, true), true); // B claim is allowed, never deduped
// null -> token landing is not a switch, no duplicate claim
const idN = nextClaimIdentity({ gameId: "g1", viewer: null, generation: 3 }, "g1", "T");
assert.equal(idN.generation, 3);
assert.equal(shouldAttemptClaim(3, idN, true), false);
// disabled / token removal: obsolete loading retires, current manual claim stays
const idRemoved = nextClaimIdentity({ gameId: "g1", viewer: "A", generation: 5 }, "g1", null);
assert.equal(idRemoved.generation, 6);
assert.equal(shouldRetireClaim(5, idRemoved, false), true);
assert.equal(shouldRetireClaim(6, idRemoved, false), false);
assert.equal(shouldRetireClaim(5, idRemoved, true), false); // enabled: re-claim path instead
assert.equal(shouldAttemptClaim(5, idRemoved, false), false); // never claim when disabled
console.log("gameCache ok");
