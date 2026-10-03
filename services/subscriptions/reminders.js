import { queueDomakinTemplateEmail } from "../background-services/domakin-mailer.js";
import BillingAttention from "../../models/BillingAttention.js";
import { USER_URL, SUBSCRIPTION_PAYMENT_ATTENTION_TEMPLATE } from "../../util/config/defines.js";
import { reconcileSubscription } from "./reconcile.js";
import { processMemberRevenueMaintenance } from "./revenue-fees.js";
import { logIntegrationError, logOperationalError } from "../../middleware/axiom-logger.js";
import { runCoordinatedSchedule } from "../jobs/coordinated-schedule.js";
import { isBusyLease, recoveryDelay } from "../jobs/recovery-backoff.js";
import { recoverMembershipCheckouts, recoverSubscriptions } from "./maintenance.js";
import { stripeOwnsBillingEmails } from "../../util/subscriptions/recovery-policy.js";

export const REMINDER_DELAY_MS = 48 * 60 * 60 * 1000;
export const nextReminderSlot = (job, now = Date.now()) => {
  if (job.resolvedAt || job.secondAttemptAt || !job.nextAttemptAt || new Date(job.nextAttemptAt).getTime() > now) return null;
  return job.firstAttemptAt ? "secondAttemptAt" : "firstAttemptAt";
};

// The branded header/footer shell lives in Domakin Mailer's own
// "subscription-payment-attention" template.
export async function deliverBillingReminder({ email, second, send = queueDomakinTemplateEmail }) {
  await send(SUBSCRIPTION_PAYMENT_ATTENTION_TEMPLATE, email, { second: !!second, manageUrl: `${USER_URL}#settings` });
}

export async function processBillingReminders({ send = deliverBillingReminder, attention = BillingAttention, reconcile = reconcileSubscription,
  shouldStop = () => false, assertOwned = async () => {} } = {}) {
  let failed = 0;
  const postpone = (job) => attention.updateOne({ _id: job._id, resolvedAt: null, nextAttemptAt: { $lte: new Date() } }, {
    $set: { nextAttemptAt: new Date(Date.now() + 5 * 60000) },
  });
  const jobs = await attention.find({ resolvedAt: null, nextAttemptAt: { $lte: new Date() } }).sort({ nextAttemptAt: 1 }).limit(50);
  for (const job of jobs) {
    if (shouldStop()) break;
    await assertOwned();
    try {
      if (stripeOwnsBillingEmails(job.stripeRegion)) {
        await attention.updateOne({ _id: job._id, resolvedAt: null }, { $set: { resolvedAt: new Date() }, $unset: { nextAttemptAt: 1 } });
        continue;
      }
      // Never send an obsolete reminder after recovery/cancellation, even if a
      // webhook was missed. A Stripe outage leaves the job pending for later.
      const result = await reconcile(job.subscriptionId, job.stripeRegion);
      if (!result || result.user.subscription.failureEpisode !== job._id) {
        await attention.updateOne({ _id: job._id, resolvedAt: null }, { $set: { resolvedAt: new Date() }, $unset: { nextAttemptAt: 1 } });
        continue;
      }
      if (!result.state?.paymentFailed || result.state.reminderNeeded === false) {
        await postpone(job);
        continue;
      }
      const slot = nextReminderSlot(job);
      if (!slot) continue;
      const now = new Date();
      const claimed = await attention.findOneAndUpdate({
        _id: job._id, resolvedAt: null, [slot]: null, nextAttemptAt: { $lte: now },
      }, { $set: { [slot]: now, ...(slot === "firstAttemptAt" ? { nextAttemptAt: new Date(now.getTime() + REMINDER_DELAY_MS) } : {}) },
        ...(slot === "secondAttemptAt" ? { $unset: { nextAttemptAt: 1 } } : {}),
      }, { new: true });
      if (!claimed) continue;
      // Mailtrap has no application-level delivery transaction with MongoDB.
      // Claim BEFORE sending and never retry an ambiguous delivery. This gives
      // at-most-two sends across restarts, duplicate events and multiple workers.
      try { await send({ email: result.user.email, second: slot === "secondAttemptAt" }); }
      catch (error) {
        failed += 1;
        logIntegrationError("mailer", error, "billing-email");
        await attention.updateOne({ _id: job._id }, { $set: { lastDeliveryError: "Provider delivery failed or was not confirmed" } });
        console.error("Billing email delivery was not confirmed", { episode: job._id, code: error.code });
      }
    } catch (error) {
      const busy = isBusyLease(error);
      const attempts = (job.recoveryAttempts || 0) + (busy ? 0 : 1);
      await assertOwned();
      await attention.updateOne({ _id: job._id, resolvedAt: null, nextAttemptAt: { $lte: new Date() } }, {
        $set: { recoveryAttempts: attempts, nextAttemptAt: new Date(Date.now() + recoveryDelay(attempts, error)) },
      });
      if (!busy) {
        failed += 1;
        logOperationalError("worker.billing-reminder", error);
        console.error("Billing reminder postponed", { episode: job._id, code: error.code });
      }
    }
  }
  return { failed };
}

export function startBillingWorker({ env = process.env, coordinate = runCoordinatedSchedule,
  reminders = processBillingReminders, checkouts = recoverMembershipCheckouts, subscriptions = recoverSubscriptions,
  revenue = processMemberRevenueMaintenance, now = Date.now, schedule = setInterval, cancel = clearInterval,
  report = logOperationalError } = {}) {
  if (env.BILLING_WORKER_ENABLED === "false" ||
      (env.BILLING_WORKER_ENABLED !== "true" && env.NODE_ENV !== "production")) return async () => {};
  let stopped = false;
  const tasks = [
    { name: "billing-maintenance", work: async ({ assertOwned }) => {
      let failed = 0;
      for (const process of [checkouts, subscriptions, reminders]) {
        if (stopped) break;
        // A slow phase cannot permanently starve reminders or other accounts.
        // Stop between operations; never race a timeout against live writes.
        const deadline = now() + 50_000;
        failed += (await process({ assertOwned, shouldStop: () => stopped || now() >= deadline })).failed;
      }
      return { failed };
    } },
    { name: "member-revenue-maintenance", intervalMs: 15 * 60_000, work: async ({ assertOwned }) => {
      await assertOwned();
      await revenue();
    } },
  ];
  const tick = () => Promise.all(tasks.map(task => {
    if (stopped || task.running || now() < (task.nextLocalAttemptAt || 0)) return task.running;
    task.running = Promise.resolve().then(() => coordinate(task.name, task.work, { intervalMs: task.intervalMs }))
      .then(() => { task.failures = 0; task.nextLocalAttemptAt = 0; })
      .catch(error => {
        task.failures = (task.failures || 0) + 1;
        task.nextLocalAttemptAt = now() + recoveryDelay(task.failures);
        report(`worker.${task.name}`, error);
      }).finally(() => { task.running = null; });
    return task.running;
  }));
  const timer = schedule(tick, 60000);
  timer.unref();
  tick();
  return async () => { stopped = true; cancel(timer); await Promise.all(tasks.map(task => task.running)); };
}
