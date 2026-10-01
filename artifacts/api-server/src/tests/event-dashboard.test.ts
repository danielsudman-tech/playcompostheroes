import assert from "node:assert/strict";
import { EventDetailCoalescer, loadHostTokens } from "../lib/eventDashboard.js";
import type { PgQueryable } from "../lib/gameStore.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function coalescesUpdatesAndReschedulesDirtyBuilds() {
  let buildCount = 0;
  let activeBuilds = 0;
  let maxActiveBuilds = 0;
  const resolvers: Array<(detail: unknown) => void> = [];
  const delivered: unknown[] = [];
  const coalescer = new EventDetailCoalescer(
    () => true,
    async () => {
      buildCount++;
      activeBuilds++;
      maxActiveBuilds = Math.max(maxActiveBuilds, activeBuilds);
      return new Promise((resolve) => resolvers.push((detail) => {
        activeBuilds--;
        resolve(detail);
      }));
    },
    (_eventId, detail) => delivered.push(detail),
    5,
  );

  coalescer.enqueue("event-1");
  coalescer.enqueue("event-1");
  coalescer.enqueue("event-1");
  await sleep(15);
  assert.equal(buildCount, 1, "bursts are collapsed into one detail build");

  coalescer.enqueue("event-1");
  coalescer.enqueue("event-1");
  resolvers[0]({ revision: 1 });
  await sleep(15);
  assert.equal(buildCount, 2, "updates received during an in-flight build schedule a follow-up build");
  assert.equal(maxActiveBuilds, 1, "only one detail build is in flight per event");

  resolvers[1]({ revision: 2 });
  await sleep(0);
  assert.deepEqual(delivered, [{ revision: 1 }, { revision: 2 }],
    "the final update is delivered instead of being lost while the first build runs");
}

async function hostTokensUseOneBatchedQuery() {
  let queryCount = 0;
  let queryText = "";
  let queryValues: unknown[] = [];
  const client = {
    query: async (sql: string, values: unknown[]) => {
      queryCount++;
      queryText = sql;
      queryValues = values;
      return { rows: [
        { game_id: "game-1", token: "host-token-1" },
        { game_id: "game-2", token: "host-token-2" },
      ] };
    },
  } as PgQueryable;

  const tokens = await loadHostTokens(client, ["game-1", "game-2"]);
  assert.equal(queryCount, 1, "host tokens are fetched with one batched query");
  assert.match(queryText, /game_id\s*=\s*ANY\(\$1::text\[\]\)/);
  assert.deepEqual(queryValues, [["game-1", "game-2"]]);
  assert.deepEqual(tokens, { "game-1": "host-token-1", "game-2": "host-token-2" });
  assert.deepEqual(await loadHostTokens(client, []), {}, "empty events do not issue an unnecessary query");
  assert.equal(queryCount, 1);
}

async function skipsDetailBuildsWithoutHostSubscribers() {
  let buildCount = 0;
  const coalescer = new EventDetailCoalescer(
    () => false,
    async () => { buildCount++; return {}; },
    () => assert.fail("a push without subscribers is not delivered"),
    5,
  );
  coalescer.enqueue("event-without-host");
  await sleep(15);
  assert.equal(buildCount, 0, "public status processing does not require host detail DTO construction");
}

await coalescesUpdatesAndReschedulesDirtyBuilds();
await hostTokensUseOneBatchedQuery();
await skipsDetailBuildsWithoutHostSubscribers();