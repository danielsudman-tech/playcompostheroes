import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import type { EventDetail } from "@workspace/api-client-react";
import {
  applyEventStreamSnapshot, eventSnapshotGenerationKey, isCurrentEventSnapshot, mergeEventStreamDetail,
} from "./event-dashboard-realtime.js";

const previous: EventDetail = {
  eventId: "event-1",
  code: "ABC123",
  name: "Workshop",
  status: "active",
  assignmentMode: "auto",
  idleSeconds: 120,
  tableCount: 1,
  tables: [{
    gameId: "game-1",
    tableNumber: 1,
    capacity: 4,
    phase: "draw",
    paused: false,
    players: [],
    progress: 0,
    currentTurnPlayerName: null,
    winner: null,
    pendingDecisionOwner: null,
    questions: [],
    lastMeaningfulActivityAt: null,
    attention: [],
    message: null,
  }],
  hostTokens: { "game-1": "private-host-token" },
};
const push = { ...previous, tables: previous.tables.map((table) => ({ ...table, phase: "play" })) };

assert.deepEqual(
  mergeEventStreamDetail("event-1", push, previous, 4, 4)?.hostTokens,
  previous.hostTokens,
  "stream updates preserve host tokens omitted from pushed DTOs",
);
assert.equal(mergeEventStreamDetail("event-2", push, previous, 4, 4), null,
  "a DTO for a different event cannot contaminate this cache");
assert.equal(mergeEventStreamDetail("event-1", push, previous, 3, 4), null,
  "a delayed detail response from an older cache generation is rejected");
assert.equal(isCurrentEventSnapshot(4, 4), true);
assert.notEqual(eventSnapshotGenerationKey("account-a", "event-1"),
  eventSnapshotGenerationKey("account-b", "event-1"),
  "snapshot generations are isolated by auth scope as well as event ID");

async function queryClientCancelsLateDetailAndAppliesStreamSnapshot() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryKey = ["/api/facilitator/events/event-1", "auth-scope"] as const;
  queryClient.setQueryData(queryKey, previous);
  let resolveStaleRead: ((detail: EventDetail) => void) | undefined;
  let staleReadSignal: AbortSignal | undefined;
  const lateRead = queryClient.fetchQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      staleReadSignal = signal;
      return new Promise<EventDetail>((resolve) => { resolveStaleRead = resolve; });
    },
  }).catch(() => undefined);
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(resolveStaleRead, "the detail GET is in flight before the SSE snapshot arrives");

  let generation = 1;
  const applied = await applyEventStreamSnapshot(
    queryClient, queryKey, "event-1", push, generation, () => generation, (detail) => detail,
  );
  assert.equal(applied, true);
  assert.equal(staleReadSignal?.aborted, true, "the in-flight detail request receives QueryClient cancellation");
  resolveStaleRead!({ ...previous, name: "late GET response" });
  await lateRead;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const current = queryClient.getQueryData<EventDetail>(queryKey);
  assert.equal(current?.tables[0].phase, "play", "SSE data is applied directly to QueryClient");
  assert.equal(current?.name, "Workshop", "the canceled late GET cannot overwrite the newer SSE snapshot");
  assert.deepEqual(current?.hostTokens, previous.hostTokens, "QueryClient cache retains omitted host tokens");

  generation++;
  const beforeMismatch = queryClient.getQueryData(queryKey);
  const mismatchApplied = await applyEventStreamSnapshot(
    queryClient, queryKey, "event-2", push, generation, () => generation, (detail) => detail,
  );
  assert.equal(mismatchApplied, false, "mismatched event DTOs are rejected by the actual cache application path");
  assert.equal(queryClient.getQueryData(queryKey), beforeMismatch);
  queryClient.clear();
}

await queryClientCancelsLateDetailAndAppliesStreamSnapshot();