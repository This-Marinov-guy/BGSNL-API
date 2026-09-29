import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  closeSpreadsheetSyncQueue,
  createSpreadsheetSyncProducer,
  getSpreadsheetSyncQueue,
} from "../services/jobs/spreadsheet-sync-queue.js";
import { listJobs as readJobs } from "../services/monitoring/jobs.js";
const listJobs = (options) => readJobs({ ...options,
  getMarketingQueue: () => ({ getJobCounts: async () => ({}), getJobs: async () => [] }) });
import {
  createSpreadsheetSyncProcessor,
  startSpreadsheetSyncWorker,
} from "../services/jobs/spreadsheet-sync-worker.js";
import { GUEST_LIST_RECONCILIATION_JOB, scheduleGuestListReconciliation } from "../services/jobs/guest-list-reconciliation.js";

const enabled = process.env.BGSNL_STORAGE_TEST_REDIS === "true";
const waitFor = async (check, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for spreadsheet job");
};
const emptyHistory = { countDocuments: async () => 0,
  find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) };

test("Redis worker consumes a durable spreadsheet job", { skip: !enabled, timeout: 15000 }, async (t) => {
  const previousPrefix = process.env.BGSNL_REDIS_PREFIX;
  process.env.BGSNL_REDIS_PREFIX = `bgsnl-spreadsheet-test:${randomUUID()}:`;
  const received = [];
  let releaseActive;
  let activeStarted;
  const activeGate = new Promise(resolve => { releaseActive = resolve; });
  const started = new Promise(resolve => { activeStarted = resolve; });
  let overlappingRuns = 0;
  let reconciliations = 0;
  const processor = createSpreadsheetSyncProcessor({
    event: async (data) => {
      if (data.id === "failing-event") throw new Error("private failure detail");
      if (data.id === "mid-flight") {
        overlappingRuns += 1;
        if (overlappingRuns === 1) { activeStarted(); await activeGate; }
      }
      received.push(data);
    },
    [GUEST_LIST_RECONCILIATION_JOB]: async () => { reconciliations += 1; },
  });
  const service = startSpreadsheetSyncWorker({ processor });
  t.after(async () => {
    await getSpreadsheetSyncQueue().removeJobScheduler(GUEST_LIST_RECONCILIATION_JOB);
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
  await waitFor(async () => (await listJobs({ status: "completed", model: emptyHistory })).total === 1);
  const completed = await listJobs({ status: "completed", model: emptyHistory });
  assert.equal(completed.items[0].status, "completed");

  await producer.enqueue("event", { id: "mid-flight" });
  await started;
  await producer.enqueue("event", { id: "mid-flight" });
  releaseActive();
  await waitFor(() => overlappingRuns === 2);

  await scheduleGuestListReconciliation();
  await waitFor(() => reconciliations === 1);

  await getSpreadsheetSyncQueue().add("event", { id: "failing-event" }, { attempts: 1 });
  await waitFor(async () => (await listJobs({ status: "failed", model: emptyHistory })).total === 1);
  const failed = await listJobs({ status: "failed", model: emptyHistory });
  assert.equal(failed.items[0].status, "failed");
  assert.equal(JSON.stringify(failed).includes("private failure detail"), false);

  const delayed = await getSpreadsheetSyncQueue().add("event", { id: "pending-event" }, { delay: 60_000 });
  const pending = await listJobs({ status: "pending", model: emptyHistory });
  assert.ok(pending.total >= 2);
  assert.ok(pending.items.some(item => item.name === "event" && item.state === "delayed"));
  await delayed.remove();
});
