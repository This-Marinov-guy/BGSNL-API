import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  closeSpreadsheetSyncQueue,
  createSpreadsheetSyncProducer,
} from "../services/jobs/spreadsheet-sync-queue.js";
import {
  createSpreadsheetSyncProcessor,
  startSpreadsheetSyncWorker,
} from "../services/jobs/spreadsheet-sync-worker.js";

const enabled = process.env.BGSNL_STORAGE_TEST_REDIS === "true";
const waitFor = async (check, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for spreadsheet job");
};

test("Redis worker consumes a durable spreadsheet job", { skip: !enabled, timeout: 15000 }, async (t) => {
  const previousPrefix = process.env.BGSNL_REDIS_PREFIX;
  process.env.BGSNL_REDIS_PREFIX = `bgsnl-spreadsheet-test:${randomUUID()}:`;
  const received = [];
  const processor = createSpreadsheetSyncProcessor({
    event: async (data) => { received.push(data); },
  });
  const service = startSpreadsheetSyncWorker({ processor });
  t.after(async () => {
    await service.stop();
    await closeSpreadsheetSyncQueue();
    process.env.BGSNL_REDIS_PREFIX = previousPrefix;
  });
  await service.worker.waitUntilReady();

  const producer = createSpreadsheetSyncProducer();
  await producer.enqueue("event", { id: "event_123" });
  await producer.enqueue("event", { id: "event_123" });
  await waitFor(() => received.length === 1);
  assert.deepEqual(received, [{ id: "event_123" }]);
});
