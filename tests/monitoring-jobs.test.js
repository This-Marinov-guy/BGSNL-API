import test from "node:test";
import assert from "node:assert/strict";
import { jobSummary as readSummary, listJobs as readJobs, normalizeJobFilter, serializeJob } from "../services/monitoring/jobs.js";

const emptyMarketingQueue = () => ({ getJobCounts: async () => ({}), getJobs: async () => [] });
const jobSummary = (options) => readSummary({ getMarketingQueue: emptyMarketingQueue, ...options });
const listJobs = (options) => readJobs({ getMarketingQueue: emptyMarketingQueue, ...options });

const counts = { failed: 2, completed: 1, wait: 1, delayed: 1, active: 0, paused: 0, prioritized: 0, "waiting-children": 0 };
const jobs = {
  failed: [{ id: "12", name: "event", timestamp: 1_700_000_000_000, finishedOn: 1_700_000_010_000,
    attemptsMade: 5, opts: { attempts: 5 }, data: { id: "private-event" }, failedReason: "private token and email" },
  { id: "11", name: "members", timestamp: 1_699_999_000_000, finishedOn: 1_699_999_010_000 }],
  completed: [{ id: "10", name: "alumni", timestamp: 1_700_000_000_000, finishedOn: 1_700_000_005_000 }],
  wait: [{ id: "9", name: "internships", timestamp: 1_700_000_000_000 }],
  delayed: [{ id: "8", name: "special-event", timestamp: 1_700_000_000_000 }],
};
const getQueue = () => ({
  getJobCounts: async () => counts,
  getJobs: async ([state], start, end) => (jobs[state] || []).slice(start, end + 1),
});
const history = [
  { _id: "abcdef0123456789abcdef01", name: "billing-maintenance", source: "scheduler", status: "failed",
    attempts: 1, createdAt: new Date(1_700_000_020_000), finishedAt: new Date(1_700_000_025_000),
    errorName: "Error", errorCode: "SECRET", payload: { email: "private@example.test" } },
  { _id: "abcdef0123456789abcdef02", name: "ticket", source: "mailer", status: "completed",
    attempts: 1, createdAt: new Date(1_700_000_015_000), finishedAt: new Date(1_700_000_018_000) },
];
const model = {
  countDocuments: async (filter) => history.filter((job) => job.status === filter.status).length,
  find: (filter) => ({ sort: () => ({ limit: (limit) => ({ lean: async () => history
    .filter((job) => !filter.status || job.status === filter.status).slice(0, limit) }) }) }),
};

test("job filters accept only supported statuses and bounded pages", () => {
  assert.deepEqual(normalizeJobFilter(undefined, undefined), { status: "all", page: 1 });
  assert.deepEqual(normalizeJobFilter("failed", "2"), { status: "failed", page: 2 });
  assert.equal(normalizeJobFilter("active", 1), null);
  assert.equal(normalizeJobFilter("all", "1.5"), null);
  assert.equal(normalizeJobFilter("all", 51), null);
});

test("monitoring counts failed, pending and completed durable jobs", async () => {
  assert.deepEqual(await jobSummary({ getQueue, model }), { available: true,
    sources: { spreadsheetSync: true, history: true, marketingCapture: true }, counts: { failed: 3, pending: 2, completed: 2 } });
  const result = await listJobs({ getQueue, model });
  assert.deepEqual(result.counts, { failed: 3, pending: 2, completed: 2 });
  assert.equal(result.total, 7);
  assert.equal(result.items.length, 7);
  assert.equal(result.items[0].name, "billing-maintenance");
  assert.equal((await listJobs({ status: "pending", getQueue, model })).items.length, 2);
  assert.equal((await listJobs({ status: "completed", getQueue, model })).items.length, 2);
});

test("job listing never exposes payloads, failure text or arbitrary names", async () => {
  const result = await listJobs({ status: "failed", getQueue, model });
  assert.equal(result.items[1].id, "12");
  assert.equal(result.items[0].status, "failed");
  assert.equal(result.items[1].attempts, 5);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.equal(serializeJob({ id: "secret-id", name: "secret-job", data: { password: "secret" } }, "waiting").name, "unknown");
});

test("history remains visible when the spreadsheet queue is unavailable", async () => {
  const unavailableQueue = () => { throw new Error("Redis unavailable"); };
  const result = await listJobs({ status: "failed", getQueue: unavailableQueue, model });
  assert.deepEqual(result.sources, { spreadsheetSync: false, history: true, marketingCapture: true });
  assert.equal(result.counts.failed, 1);
  assert.equal(result.items[0].name, "billing-maintenance");
});

test("marketing retries are included without leaking recipient details", async () => {
  const getMarketingQueue = () => ({ getJobCounts: async () => ({ failed: 1, delayed: 1 }),
    getJobs: async ([state]) => ["failed", "delayed"].includes(state) ? [{ id: "22", name: "marketing-capture",
      attemptsMade: state === "failed" ? 4 : 1, opts: { attempts: 4 },
      data: { email: "secret@example.test" }, failedReason: "secret" }] : [] });
  const result = await listJobs({ getQueue, model, getMarketingQueue });
  assert.deepEqual(result.counts, { failed: 4, pending: 3, completed: 2 });
  const failed = result.items.find((job) => job.source === "marketing-capture" && job.status === "failed");
  assert.equal(failed.attempts, 4);
  assert.equal(failed.maxAttempts, 4);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  const unavailable = await jobSummary({ getQueue, model, getMarketingQueue: () => { throw new Error("offline"); } });
  assert.equal(unavailable.sources.marketingCapture, false);
  assert.equal(unavailable.available, true);
});

test("job pages stay bounded while browsing retained history", async () => {
  const records = Array.from({ length: 25 }, (_, index) => ({ _id: `abcdef0123456789${String(index).padStart(8, "0")}`,
    name: "billing-maintenance", source: "scheduler", status: "completed", attempts: 1,
    createdAt: new Date(1_700_000_000_000 - index * 1000), activityAt: new Date(1_700_000_000_000 - index * 1000) }));
  const historyModel = { countDocuments: async (filter) => filter.status === "completed" ? 25 : 0,
    find: () => ({ sort: () => ({ limit: (limit) => ({ lean: async () => records.slice(0, limit) }) }) }) };
  const emptyQueue = () => ({ getJobCounts: async () => ({}), getJobs: async () => [] });
  const result = await listJobs({ status: "completed", page: 2, getQueue: emptyQueue, model: historyModel });
  assert.equal(result.items.length, 5);
  assert.equal(result.total, 25);
  assert.equal(result.hasMore, false);
});
