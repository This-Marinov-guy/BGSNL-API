import { sendEmail, useDomakinMailer } from "../background-services/email-provider.js";
import BillingAttention from "../../models/BillingAttention.js";
import User from "../../models/User.js";
import AlumniUser from "../../models/AlumniUser.js";
import BillingRecord from "../../models/BillingRecord.js";
import { createStripeClient } from "../../util/config/stripe.js";
import { completeMembershipCheckout } from "./checkout.js";
import { NO_REPLY_EMAIL, NO_REPLY_EMAIL_NAME, USER_URL } from "../../util/config/defines.js";
import { CURRENT_ACCOUNT_FILTER } from "../../util/subscriptions/policy.js";
import { reconcileAccount, reconcileSubscription } from "./reconcile.js";

export const REMINDER_DELAY_MS = 48 * 60 * 60 * 1000;
export const nextReminderSlot = (job, now = Date.now()) => {
  if (job.resolvedAt || job.secondAttemptAt || !job.nextAttemptAt || new Date(job.nextAttemptAt).getTime() > now) return null;
  return job.firstAttemptAt ? "secondAttemptAt" : "firstAttemptAt";
};

export async function deliverBillingReminder({ email, second }) {
  const message = "We could not collect your subscription payment. Your account benefits are locked. " +
    "Please sign in and open Manage billing to update your payment method and pay the outstanding invoice, " +
    "or cancel your subscription in the billing portal. Changing your card alone does not restore benefits until payment succeeds. " +
    "Cancelling stops the subscription; it does not restore paid benefits or automatically settle an outstanding invoice.";
  const delivery = sendEmail({
    from: { email: NO_REPLY_EMAIL, name: NO_REPLY_EMAIL_NAME }, to: [{ email }],
    subject: second ? "Reminder: your subscription payment needs attention" : "Your subscription payment needs attention",
    text: `${message}\n\nManage your subscription: ${USER_URL}#settings`,
    html: `<p>${message}</p><p><a href="${USER_URL}#settings">Manage your subscription</a></p>`,
    category: "subscription-payment-attention",
  });
  let timeout;
  try {
    await Promise.race([delivery, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Mail delivery timed out")), useDomakinMailer() ? 100000 : 60000);
    })]);
  } finally { clearTimeout(timeout); }
}

export async function processBillingReminders({ send = deliverBillingReminder, attention = BillingAttention, reconcile = reconcileSubscription } = {}) {
  const postpone = (job) => attention.updateOne({ _id: job._id, resolvedAt: null, nextAttemptAt: { $lte: new Date() } }, {
    $set: { nextAttemptAt: new Date(Date.now() + 5 * 60000) },
  });
  const jobs = await attention.find({ resolvedAt: null, nextAttemptAt: { $lte: new Date() } }).sort({ nextAttemptAt: 1 }).limit(50);
  for (const job of jobs) {
    try {
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
        await attention.updateOne({ _id: job._id }, { $set: { lastDeliveryError: "Provider delivery failed or was not confirmed" } });
        console.error("Billing email delivery was not confirmed", { episode: job._id, code: error.code });
      }
    } catch (error) {
      await postpone(job);
      console.error("Billing reminder postponed", { episode: job._id, code: error.code });
    }
  }
}

export function startBillingWorker() {
  if (process.env.BILLING_WORKER_ENABLED === "false" ||
      (process.env.BILLING_WORKER_ENABLED !== "true" && process.env.NODE_ENV !== "production")) return async () => {};
  let stopped = false;
  let running;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      await processBillingReminders();
      // Recover paid checkouts even if their initial webhook was never delivered.
      const checkouts = await BillingRecord.find({ "data.sessionId": { $exists: true }, completedAt: null })
        .sort({ updatedAt: 1 }).limit(25);
      for (const checkout of checkouts) {
        if (stopped) return;
        try {
          const stripe = createStripeClient(checkout.data.stripeRegion);
          const payment = await stripe.checkout.sessions.retrieve(checkout.data.sessionId);
          if (payment.status === "complete") await completeMembershipCheckout(payment, checkout.data.stripeRegion);
          if (payment.status === "expired") {
            await BillingRecord.updateOne({ _id: checkout.id }, { $unset: { "data.registration": 1 }, $set: { completedAt: new Date() } });
          } else await BillingRecord.updateOne({ _id: checkout.id }, { $set: { updatedAt: new Date() } });
        } catch (error) {
          await BillingRecord.updateOne({ _id: checkout.id }, { $set: { updatedAt: new Date() } });
          console.error("Checkout reconciliation postponed", { checkoutId: checkout.id, code: error.code });
        }
      }
      // Bounded recovery sweep; the oldest snapshots go first. Webhooks remain
      // the immediate path, and benefit requests also reconcile with Stripe.
      for (const Model of [User, AlumniUser]) {
        const users = await Model.find({ ...CURRENT_ACCOUNT_FILTER,
          "subscription.id": { $exists: true, $nin: [null, ""] },
          $or: [{ "subscription.syncedAt": { $exists: false } },
            { "subscription.syncedAt": { $lt: new Date(Date.now() - 5 * 60000) } }],
        }).sort({ "subscription.lastAttemptAt": 1, "subscription.syncedAt": 1 }).limit(25);
        for (const user of users) {
          if (stopped) return;
          try { await reconcileAccount(user); }
          catch (error) {
            // Rotate failed records behind other accounts without making an
            // unverified entitlement snapshot appear fresh.
            await Model.updateOne({ _id: user.id, "subscription.id": user.subscription.id }, { $set: { "subscription.lastAttemptAt": new Date() } });
            console.error("Subscription reconciliation postponed", { accountId: user.id, code: error.code });
          }
        }
      }
    })().catch(() => console.error("Billing maintenance failed; retrying on the next tick"))
      .finally(() => { running = null; });
  };
  const timer = setInterval(tick, 60000);
  timer.unref();
  tick();
  return async () => { stopped = true; clearInterval(timer); await running; };
}
