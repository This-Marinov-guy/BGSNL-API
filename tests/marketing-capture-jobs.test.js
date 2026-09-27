import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import MarketingEmail from "../models/MarketingEmail.js";
import { queueMarketingEmail } from "../middleware/capture-marketing-email.js";
import { withJobTimeout, JobTimeoutError } from "../services/jobs/job-timeout.js";
import { createMarketingCaptureProducer, marketingCaptureData, MARKETING_CAPTURE_QUEUE,
  MARKETING_JOB_OPTIONS } from "../services/jobs/marketing-capture-queue.js";
import { createMarketingCaptureProcessor, startMarketingCaptureWorker,
  MARKETING_DATABASE_TIMEOUT_MS } from "../services/jobs/marketing-capture-worker.js";

const entry = { email: " Person@Example.test ", city: "  The   Hague ",
  consent: { granted: true, recordedAt: new Date("2026-09-27T10:00:00Z"), textVersion: "test-v1" } };

test("producer persists only normalized consent fields and configures three retries", async () => {
  let received;
  const producer = createMarketingCaptureProducer({ getQueue: () => ({ waitUntilReady: async () => {},
    add: async (...args) => { received = args; return { id: "1" }; } }) });
  assert.deepEqual(await producer.enqueue({ ...entry, password: "secret" }, "POST /form?token=secret"), { id: "1" });
  assert.equal(received[0], MARKETING_CAPTURE_QUEUE);
  assert.equal(received[1].email, "person@example.test");
  assert.equal(received[1].city, "the hague");
  assert.equal(received[1].consent.source, "POST /form");
  assert.equal(received[1].consent.recordedAt, entry.consent.recordedAt.toISOString());
  assert.equal(JSON.stringify(received).includes("secret"), false);
  assert.equal(received[2].attempts, 4);
  assert.deepEqual(received[2].backoff, { type: "exponential", delay: 1000 });
});

test("invalid/missing consent is never queued", async () => {
  let calls = 0;
  const producer = createMarketingCaptureProducer({ getQueue: () => { calls++; } });
  await assert.rejects(producer.enqueue({ ...entry, consent: { granted: false } }), /consent/);
  await assert.rejects(producer.enqueue({ ...entry, email: "invalid" }));
  assert.equal(calls, 0);
});

test("enqueue timeout prevents late queue readiness from submitting work", async () => {
  let ready;
  let writes = 0;
  const producer = createMarketingCaptureProducer({ timeoutMs: 10, getQueue: () => ({
    waitUntilReady: () => new Promise((resolve) => { ready = resolve; }),
    add: async () => { writes++; },
  }) });
  await assert.rejects(producer.enqueue(entry), JobTimeoutError);
  ready();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
});

test("successful attempts keep consent timestamp and bound database execution", async () => {
  let received;
  const processor = createMarketingCaptureProcessor({ model: { add: async (...args) => { received = args; } } });
  const data = marketingCaptureData(entry);
  await processor({ name: MARKETING_CAPTURE_QUEUE, data });
  assert.equal(received[0].consent.recordedAt, data.consent.recordedAt);
  assert.equal(received[1].maxTimeMS, MARKETING_DATABASE_TIMEOUT_MS);
});

test("failed and hung attempts reject so the queue can retry", async () => {
  const job = { name: MARKETING_CAPTURE_QUEUE, data: marketingCaptureData(entry) };
  const fail = createMarketingCaptureProcessor({ model: { add: async () => { throw new Error("database unavailable"); } } });
  await assert.rejects(fail(job), /database unavailable/);
  const hang = createMarketingCaptureProcessor({ model: { add: () => new Promise(() => {}) }, timeoutMs: 10 });
  await assert.rejects(hang(job), JobTimeoutError);
  await assert.rejects(hang({ name: "other", data: job.data }), /Unknown/);
});

test("timeout helper returns results, propagates errors and aborts expired work", async () => {
  assert.equal(await withJobTimeout(async () => 42, 100), 42);
  await assert.rejects(withJobTimeout(async () => { throw new Error("failed"); }, 100), /failed/);
  let signal;
  await assert.rejects(withJobTimeout((value) => { signal = value; return new Promise(() => {}); }, 10), JobTimeoutError);
  assert.equal(signal.aborted, true);
});

test("capture enqueue errors cannot break an already-successful form", async () => {
  assert.equal(queueMarketingEmail(null), undefined);
  await queueMarketingEmail(entry, "POST /form", () => { throw new Error("Redis down"); });
});

test("model guards consent replays and propagates execution timeout to both query paths", async () => {
  const calls = [];
  const model = {
    findOneAndUpdate: async (...args) => { calls.push(args); throw Object.assign(new Error("duplicate"), { code: 11000 }); },
    findOne: async (...args) => { calls.push(args); return { unsubscribed: true }; },
  };
  const result = await MarketingEmail.add.call(model, entry, { maxTimeMS: 5000 });
  assert.equal(result.unsubscribed, true);
  assert.deepEqual(calls[0][0].$or, [{ "consent.recordedAt": { $lt: entry.consent.recordedAt } }, { "consent.recordedAt": null }]);
  assert.equal(calls[0][2].upsert, true);
  assert.equal(calls[0][2].maxTimeMS, 5000);
  assert.equal(calls[1][2].maxTimeMS, 5000);
});

test("worker lifecycle registers errors and disconnects on shutdown", async () => {
  let stopped = false;
  let disconnected = false;
  class FakeWorker extends EventEmitter {
    constructor(name, processor, options) { super(); this.name = name; this.processor = processor; this.options = options; }
    async close() { stopped = true; }
  }
  const service = startMarketingCaptureWorker({ WorkerClass: FakeWorker,
    connection: { disconnect: () => { disconnected = true; } }, processor: async () => {} });
  assert.equal(service.worker.name, MARKETING_CAPTURE_QUEUE);
  assert.equal(service.worker.listenerCount("failed"), 1);
  assert.equal(service.worker.listenerCount("error"), 1);
  assert.equal(MARKETING_JOB_OPTIONS.attempts, 4);
  await service.stop();
  assert.ok(stopped && disconnected);
});
