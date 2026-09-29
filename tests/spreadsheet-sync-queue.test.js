import assert from "node:assert/strict";
import test from "node:test";
import { createSpreadsheetSyncProcessor } from "../services/jobs/spreadsheet-sync-worker.js";
import { createSpreadsheetSyncProducer, spreadsheetSyncJob } from "../services/jobs/spreadsheet-sync-queue.js";

test("spreadsheet jobs use stable deduplication IDs and bounded retries", async () => {
  const added = [];
  const producer = createSpreadsheetSyncProducer({ getQueue: () => ({ add: (...args) => { added.push(args); return Promise.resolve({ id: "job" }); } }) });
  await producer.enqueue("event", { id: "event_123" });
  await producer.enqueue("members", { region: null });

  assert.deepEqual(spreadsheetSyncJob("special-event", { id: "event_123" }), {
    type: "special-event", data: { id: "event_123" }, deduplicationId: "special-event_event_123",
  });
  assert.equal(added[0][2].deduplication.id, "event_event_123");
  assert.equal(added[0][2].deduplication.keepLastIfActive, true);
  assert.equal(added[0][2].attempts, 5);
  assert.deepEqual(added[0][2].backoff, { type: "exponential", delay: 1000 });
  assert.equal(added[1][2].deduplication.id, "members_all");
});

test("spreadsheet worker dispatches a job to its matching handler", async () => {
  const handled = [];
  const processor = createSpreadsheetSyncProcessor({ event: async (data) => handled.push(data) });
  await processor({ name: "event", data: { id: "event_123" } });
  assert.deepEqual(handled, [{ id: "event_123" }]);
  await assert.rejects(processor({ name: "unknown", data: {} }), /Unknown spreadsheet synchronization job/);
});
