import assert from "node:assert/strict";
import { createStreamRefresh } from "./gameStreamRefresh";

async function main() {
  let active = true;
  let calls = 0;
  let finish!: () => void;
  const refresh = createStreamRefresh(() => {
    calls++;
    return new Promise<void>(resolve => { finish = resolve; });
  }, () => active);
  refresh(); refresh(); refresh();
  await Promise.resolve();
  assert.equal(calls, 1, "a burst of SSE refresh events triggers one viewer GET");
  finish();
  await new Promise(resolve => setImmediate(resolve));
  refresh();
  await Promise.resolve();
  assert.equal(calls, 2, "a later refresh can recover again");
  finish();
  await new Promise(resolve => setImmediate(resolve));
  active = false;
  refresh();
  assert.equal(calls, 2, "closed or previous-seat streams cannot refetch");
  const closedBeforeFetch = createStreamRefresh(async () => { calls++; }, () => active);
  active = true;
  closedBeforeFetch();
  active = false;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  let failures = 0;
  active = true;
  const failing = createStreamRefresh(async () => { failures++; throw new Error("offline"); }, () => active);
  failing();
  await new Promise(resolve => setImmediate(resolve));
  failing();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failures, 2, "failed GETs do not wedge the recovery guard");
  console.log("gameStreamRefresh: one viewer refetch, coalescing, closed-stream and failure guards passed");
}
void main();