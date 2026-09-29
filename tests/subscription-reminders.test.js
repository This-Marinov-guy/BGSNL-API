import assert from "node:assert/strict";
import test from "node:test";
import { processBillingReminders, nextReminderSlot, REMINDER_DELAY_MS, deliverBillingReminder } from "../services/subscriptions/reminders.js";
import { SUBSCRIPTION_PAYMENT_ATTENTION_TEMPLATE, USER_URL } from "../util/config/defines.js";

const harness = () => {
  const job = { _id: "episode", subscriptionId: "sub_one", stripeRegion: "amsterdam", nextAttemptAt: new Date(0) };
  let failed = true;
  const sent = [];
  const attention = {
    find: () => ({ sort: () => ({ limit: async () => [structuredClone(job)] }) }),
    findOneAndUpdate: async (query, update) => {
      const slot = "firstAttemptAt" in query ? "firstAttemptAt" : "secondAttemptAt";
      if (job[slot] || job.resolvedAt || !job.nextAttemptAt || job.nextAttemptAt > query.nextAttemptAt.$lte) return null;
      Object.assign(job, update.$set);
      for (const key of Object.keys(update.$unset || {})) delete job[key];
      return structuredClone(job);
    },
    updateOne: async (query, update) => {
      if (query.nextAttemptAt && (!job.nextAttemptAt || job.nextAttemptAt > query.nextAttemptAt.$lte)) return;
      if (query.resolvedAt === null && job.resolvedAt) return;
      Object.assign(job, update.$set);
      for (const key of Object.keys(update.$unset || {})) delete job[key];
    },
  };
  const dependencies = { attention, send: async (data) => sent.push(data),
    reconcile: async () => ({ state: { paymentFailed: failed }, user: { email: "test@example.test", subscription: { failureEpisode: "episode" } } }) };
  return { job, sent, dependencies, recover: () => { failed = false; }, process: () => processBillingReminders(dependencies) };
};
test("first reminder is due immediately, second no earlier than 48 hours", async () => {
  const h = harness(); await h.process();
  assert.equal(h.sent.length, 1);
  assert.equal(h.job.nextAttemptAt - h.job.firstAttemptAt, REMINDER_DELAY_MS);
  await h.process();
  assert.equal(h.sent.length, 1);
});

test("queued central billing reminders are retired without sending duplicate Stripe emails", async () => {
  const h = harness(); h.job.stripeRegion = "netherlands";
  h.dependencies.reconcile = () => assert.fail("No Stripe lookup is needed to retire legacy central reminders");
  await h.process(); await h.process();
  assert.equal(h.sent.length, 0);
  assert.ok(h.job.resolvedAt);
  assert.equal(h.job.nextAttemptAt, undefined);
});
test("concurrent workers and replays cannot send more than two emails per episode", async () => {
  const h = harness();
  await Promise.all([h.process(), h.process(), h.process()]);
  assert.equal(h.sent.length, 1);
  h.job.nextAttemptAt = new Date(0);
  await Promise.all([h.process(), h.process(), h.process()]);
  assert.equal(h.sent.length, 2);
  await h.process();
  assert.equal(h.sent.length, 2);
});
test("recovered or cancelled accounts receive no pending reminder", async () => {
  const h = harness(); await h.process(); h.recover(); h.job.nextAttemptAt = new Date(0);
  await h.process(); assert.equal(h.sent.length, 1);
});
test("ambiguous provider failures are recorded and never retried as an extra email", async () => {
  const h = harness(); let calls = 0;
  h.dependencies.send = async () => { calls++; throw new Error("Timeout after acceptance"); };
  await h.process(); await h.process();
  assert.equal(calls, 1); assert.ok(h.job.firstAttemptAt); assert.ok(h.job.lastDeliveryError);
});
test("Stripe outages postpone reminders without consuming an email attempt", async () => {
  const h = harness(); h.dependencies.reconcile = async () => { throw new Error("Unavailable"); };
  await h.process(); assert.equal(h.job.firstAttemptAt, undefined); assert.equal(h.sent.length, 0);
  assert.ok(h.job.nextAttemptAt > new Date());
});
test("orphaned reminder jobs are retired so they cannot starve other accounts", async () => {
  const h = harness(); h.dependencies.reconcile = async () => null;
  await h.process();
  assert.ok(h.job.resolvedAt); assert.equal(h.job.nextAttemptAt, undefined); assert.equal(h.sent.length, 0);
});
test("in-flight payments are postponed without consuming or accelerating email slots", async () => {
  const h = harness();
  h.dependencies.reconcile = async () => ({ state: { paymentFailed: true, reminderNeeded: false }, user: { subscription: { failureEpisode: "episode" } } });
  await h.process();
  assert.equal(h.job.firstAttemptAt, undefined); assert.ok(h.job.nextAttemptAt > new Date());
  h.job.nextAttemptAt = new Date(Date.now() + REMINDER_DELAY_MS);
  const due = h.job.nextAttemptAt.getTime();
  await h.process();
  assert.equal(h.job.nextAttemptAt.getTime(), due); assert.equal(h.sent.length, 0);
});
test("resolved episodes and used second slots never become eligible again", () => {
  assert.equal(nextReminderSlot({ nextAttemptAt: new Date(0), resolvedAt: new Date() }), null);
  assert.equal(nextReminderSlot({ nextAttemptAt: new Date(0), secondAttemptAt: new Date() }), null);
});
test("billing reminder queues the Domakin Mailer template with the manage-billing link", async () => {
  const calls = [];
  await deliverBillingReminder({ email: "member@example.test", second: true, send: async (...args) => calls.push(args) });
  assert.deepEqual(calls, [[SUBSCRIPTION_PAYMENT_ATTENTION_TEMPLATE, "member@example.test", { second: true, manageUrl: `${USER_URL}#settings` }]]);
});
