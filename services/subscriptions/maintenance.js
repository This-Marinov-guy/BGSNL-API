import BillingRecord from "../../models/BillingRecord.js";
import MemberUser from "../../models/MemberUser.js";
import AlumniUser from "../../models/AlumniUser.js";
import { createStripeClient, STRIPE_KEYS } from "../../util/config/stripe.js";
import { CURRENT_ACCOUNT_FILTER } from "../../util/subscriptions/policy.js";
import { completeMembershipCheckout } from "./checkout.js";
import { reconcileAccount } from "./reconcile.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { isBusyLease, recoveryDelay } from "../jobs/recovery-backoff.js";

const due = (path, now) => ({ $or: [{ [path]: null }, { [path]: { $lte: new Date(now) } }] });
export const membershipRecoveryFilter = now => ({
  // Legacy membership records already use these prefixes. Ticket claims share
  // the store but must never be sent to subscription fulfillment.
  _id: /^(account-checkout|signup):/,
  "data.sessionId": { $exists: true, $nin: [null, ""] },
  completedAt: null,
  ...due("recovery.nextAttemptAt", now),
});

export async function recoverMembershipCheckouts({ records = BillingRecord, stripeFor = createStripeClient,
  complete = completeMembershipCheckout, now = Date.now, shouldStop = () => false,
  assertOwned = async () => {}, report = logOperationalError } = {}) {
  let failed = 0, processed = 0;
  const checkouts = await records.find(membershipRecoveryFilter(now())).sort({ updatedAt: 1 }).limit(25);
  for (const checkout of checkouts) {
    if (shouldStop()) break;
    await assertOwned();
    const query = { _id: checkout._id, "data.sessionId": checkout.data.sessionId, completedAt: null };
    try {
      if (!Object.hasOwn(STRIPE_KEYS, checkout.data.stripeRegion)) throw new Error("Membership checkout has no valid billing region");
      const payment = await stripeFor(checkout.data.stripeRegion).checkout.sessions.retrieve(checkout.data.sessionId);
      if (payment.mode !== "subscription" || payment.metadata?.method !== "membership_checkout" ||
          payment.metadata?.checkoutKey !== checkout._id) throw new Error("Checkout is not the expected membership payment");
      await assertOwned();
      if (payment.status === "complete") await complete(payment, checkout.data.stripeRegion);
      if (payment.status === "expired") {
        await records.updateOne(query, { $unset: { "data.registration": 1, recovery: 1 }, $set: { completedAt: new Date(now()) } });
      } else {
        await records.updateOne(query, { $set: { recovery: { attempts: 0, nextAttemptAt: new Date(now() + 5 * 60_000) } } });
      }
      processed++;
    } catch (error) {
      const busy = isBusyLease(error);
      const attempts = (checkout.recovery?.attempts || 0) + (busy ? 0 : 1);
      await assertOwned();
      await records.updateOne(query, { $set: { recovery: {
        attempts, nextAttemptAt: new Date(now() + recoveryDelay(attempts, error)),
      } } });
      if (!busy) { failed++; report("worker.checkout-reconciliation", error); }
    }
  }
  return { failed, processed };
}

export async function recoverSubscriptions({ models = [MemberUser, AlumniUser], reconcile = reconcileAccount,
  now = Date.now, shouldStop = () => false, assertOwned = async () => {}, report = logOperationalError } = {}) {
  let failed = 0, processed = 0;
  for (const Model of models) {
    if (shouldStop()) break;
    const users = await Model.find({ ...CURRENT_ACCOUNT_FILTER,
      "subscription.id": { $exists: true, $nin: [null, ""] },
      $and: [due("subscription.nextRecoveryAt", now()), { $or: [
        { "subscription.syncedAt": null }, { "subscription.syncedAt": { $lt: new Date(now() - 5 * 60_000) } },
      ] }],
    }).sort({ "subscription.lastAttemptAt": 1, "subscription.syncedAt": 1 }).limit(25);
    for (const user of users) {
      if (shouldStop()) break;
      await assertOwned();
      try { await reconcile(user); processed++; }
      catch (error) {
        const busy = isBusyLease(error);
        const attempts = (user.subscription.recoveryAttempts || 0) + (busy ? 0 : 1);
        await assertOwned();
        // Do not overwrite a newer webhook snapshot or replacement subscription.
        await Model.updateOne({ _id: user.id, "subscription.id": user.subscription.id,
          "subscription.syncedAt": user.subscription.syncedAt || null }, { $set: {
          "subscription.lastAttemptAt": new Date(now()), "subscription.recoveryAttempts": attempts,
          "subscription.nextRecoveryAt": new Date(now() + recoveryDelay(attempts, error)),
        } });
        if (!busy) { failed++; report("worker.subscription-reconciliation", error); }
      }
    }
  }
  return { failed, processed };
}
