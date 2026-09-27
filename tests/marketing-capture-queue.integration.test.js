import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createMarketingCaptureProducer, closeMarketingCaptureQueue, getMarketingCaptureQueue } from "../services/jobs/marketing-capture-queue.js";
import { createMarketingCaptureProcessor, startMarketingCaptureWorker } from "../services/jobs/marketing-capture-worker.js";
import { listJobs } from "../services/monitoring/jobs.js";

const enabled = process.env.BGSNL_STORAGE_TEST_REDIS === "true";
const waitFor = async (check, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for marketing jobs");
};

test("durable marketing jobs survive producer restart, retry failures/timeouts three times, and stay visible", {
  skip: !enabled, timeout: 25_000,
}, async (t) => {
  const previousPrefix = process.env.BGSNL_REDIS_PREFIX;
  process.env.BGSNL_REDIS_PREFIX = `bgsnl-marketing-test:${randomUUID()}:`;
  let service;
  const jobs = [];
  t.after(async () => {
    await service?.stop();
    for (const job of jobs) await job.remove();
    await closeMarketingCaptureQueue();
    if (previousPrefix === undefined) delete process.env.BGSNL_REDIS_PREFIX;
    else process.env.BGSNL_REDIS_PREFIX = previousPrefix;
  });
  const producer = createMarketingCaptureProducer();
  const ids = [];
  for (const name of ["recover", "fail", "hang"]) {
    const job = await producer.enqueue({ email: `${name}@example.test`, city: "test",
      consent: { granted: true, recordedAt: new Date(), textVersion: "test" } }, "integration-test");
    ids.push(job.id);
  }
  // No worker existed when these were queued. Recreate the producer connection
  // to prove processing does not depend on the original request/process state.
  await closeMarketingCaptureQueue();
  const queue = getMarketingCaptureQueue();
  await queue.waitUntilReady();
  for (const id of ids) jobs.push(await queue.getJob(id));
  const calls = new Map();
  const processor = createMarketingCaptureProcessor({ timeoutMs: 50, model: {
    async add(data) {
      const count = (calls.get(data.email) || 0) + 1;
      calls.set(data.email, count);
      if (data.email === "hang@example.test") return new Promise(() => {});
      if (data.email === "fail@example.test" || count < 3) throw new Error("Synthetic failure");
      return undefined;
    },
  } });
  service = startMarketingCaptureWorker({ processor });
  await service.worker.waitUntilReady();
  await waitFor(async () => {
    const counts = await queue.getJobCounts("completed", "failed");
    return counts.completed === 1 && counts.failed === 2;
  });
  assert.equal(calls.get("recover@example.test"), 3);
  assert.equal(calls.get("fail@example.test"), 4);
  assert.equal(calls.get("hang@example.test"), 4);
  const result = await listJobs({ getMarketingQueue: () => queue,
    getQueue: () => ({ getJobCounts: async () => ({}), getJobs: async () => [] }),
    model: { countDocuments: async () => 0, find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) },
  });
  assert.deepEqual(result.counts, { completed: 1, failed: 2, pending: 0 });
  assert.equal(result.items.filter((job) => job.attempts === 4).length, 2);
  assert.equal(JSON.stringify(result).includes("example.test"), false);
});
