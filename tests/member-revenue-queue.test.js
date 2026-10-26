import test from "node:test";
import assert from "node:assert/strict";
import { enqueueMemberRevenueFromWebhook, scheduleMemberRevenueSweep, shouldQueueMemberRevenue, MEMBER_REVENUE_SWEEP_INTERVAL_MS } from "../services/subscriptions/member-revenue-queue.js";
import { createMemberRevenueProcessor } from "../services/subscriptions/member-revenue-worker.js";
import { notifyMemberRevenueIssues } from "../services/subscriptions/member-revenue-alerts.js";
import { notifyFinalQueueFailure } from "../services/monitoring/queue-failure-alert.js";

const env = { MEMBER_REVENUE_SHARING_ENABLED: "true" };
test("verified national Stripe events enqueue one bounded revenue sweep", async () => {
  const jobs = [];
  const event = { type: "invoice.paid", livemode: true, data: { object: { status: "paid", subscription: "sub_one" } } };
  assert.equal(shouldQueueMemberRevenue(event, "netherlands", env), true);
  assert.equal(shouldQueueMemberRevenue(event, "amsterdam", env), false);
  assert.equal(shouldQueueMemberRevenue({ ...event, account: "acct_connected" }, "netherlands", env), false);
  assert.equal(shouldQueueMemberRevenue({ ...event, livemode: false }, "netherlands", env), false);
  assert.equal(shouldQueueMemberRevenue({ ...event, data: { object: { status: "open" } } }, "netherlands", env), false);
  await enqueueMemberRevenueFromWebhook(event, "netherlands", { env,
    getQueue: () => ({ add: async (...args) => jobs.push(args) }) });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0][2].attempts, 1);
  assert.equal(jobs[0][2].deduplication.keepLastIfActive, true);
});

test("a deferred transfer alerts without failing or delaying the next job", async () => {
  const alerts = [];
  const issue = { kind: "insufficient-balance", invoiceId: "in_one", accountId: "acct_one", amount: 760 };
  const process = createMemberRevenueProcessor({ process: async () => ({ failed: 1, issues: [issue] }),
    notifyIssues: async issues => alerts.push(issues) });
  assert.equal((await process({ name: "member-revenue" })).failed, 1);
  assert.equal((await process({ name: "member-revenue" })).failed, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(alerts, [[issue], [issue]]);
  await assert.rejects(process({ name: "other" }), /Unknown/);
});

test("revenue recovery is scheduled daily and unexpected failures alert after one attempt", async () => {
  const calls = [];
  await scheduleMemberRevenueSweep(() => ({ upsertJobScheduler: async (...args) => calls.push(args) }));
  assert.equal(MEMBER_REVENUE_SWEEP_INTERVAL_MS, 24 * 60 * 60 * 1000);
  assert.equal(calls[0][1].every, 24 * 60 * 60 * 1000);
  assert.equal(calls[0][2].opts.attempts, 1);
  const alerts = [];
  const job = { id: "42", name: "member-revenue", attemptsMade: 1, opts: { attempts: 1 }, finishedOn: Date.now() };
  const policy = { queueFailure: async (...args) => alerts.push(args) };
  assert.equal(await notifyFinalQueueFailure({ ...job, attemptsMade: 0 }, "member-revenue", { policy }), false);
  assert.equal(await notifyFinalQueueFailure(job, "member-revenue", { policy }), true);
  assert.deepEqual(alerts, [["member-revenue", "member-revenue", "42", 1]]);
});

test("unresolved transfer alerts are deduplicated and a failed send can retry", async () => {
  const keys = new Map();
  const redis = {
    set: async (key, owner) => keys.has(key) ? null : (keys.set(key, owner), "OK"),
    eval: async (script, _count, key, owner) => {
      if (keys.get(key) !== owner) return 0;
      if (script.includes("EXPIRE")) return 1;
      keys.delete(key); return 1;
    },
  };
  const issue = { kind: "insufficient-balance", invoiceId: "in_one", accountId: "acct_one" };
  const getQueue = () => ({ client: Promise.resolve(redis) });
  let sends = 0;
  const send = async () => ++sends;
  assert.equal(await notifyMemberRevenueIssues([issue, issue], { getQueue, send }), 1);
  assert.equal(await notifyMemberRevenueIssues([issue], { getQueue, send }), 0);
  assert.equal(sends, 1);
  keys.clear();
  assert.equal(await notifyMemberRevenueIssues([issue], { getQueue, send: async () => 0 }), 0);
  assert.equal(keys.size, 0);
  assert.equal(await notifyMemberRevenueIssues([issue], { getQueue, send }), 2);
});
