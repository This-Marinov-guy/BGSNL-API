import test from "node:test";
import assert from "node:assert/strict";
import { enqueueMemberRevenueFromWebhook, shouldQueueMemberRevenue } from "../services/subscriptions/member-revenue-queue.js";
import { createMemberRevenueProcessor } from "../services/subscriptions/member-revenue-worker.js";
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
  assert.equal(jobs[0][2].attempts, 5);
  assert.equal(jobs[0][2].deduplication.keepLastIfActive, true);
});

test("revenue worker retries reported settlement failures and final failure alerts once", async () => {
  const process = createMemberRevenueProcessor({ process: async () => ({ failed: 2 }) });
  await assert.rejects(process({ name: "member-revenue" }), /deferred/);
  await assert.rejects(process({ name: "other" }), /Unknown/);
  const alerts = [];
  const job = { id: "42", name: "member-revenue", attemptsMade: 4, opts: { attempts: 5 }, finishedOn: Date.now() };
  const policy = { queueFailure: async (...args) => alerts.push(args) };
  assert.equal(await notifyFinalQueueFailure(job, "member-revenue", { policy }), false);
  assert.equal(await notifyFinalQueueFailure({ ...job, attemptsMade: 5 }, "member-revenue", { policy }), true);
  assert.deepEqual(alerts, [["member-revenue", "member-revenue", "42", 5]]);
});
