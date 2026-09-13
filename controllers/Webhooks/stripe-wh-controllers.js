import HttpError from "../../models/Http-error.js";
import { captureMemberRevenueEvent } from "../../services/subscriptions/revenue-sharing.js";
import BillingRecord from "../../models/BillingRecord.js";
import { createStripeClient, getStripeKey, STRIPE_KEYS } from "../../util/config/stripe.js";
import { stripeId, invoiceSubscriptionId } from "../../util/subscriptions/policy.js";
import { withBillingLease } from "../../services/subscriptions/lease.js";
import { canonicalStripeRegion, reconcileSubscription, reconcileAccount, readStripeSubscription } from "../../services/subscriptions/reconcile.js";
import { completeMembershipCheckout } from "../../services/subscriptions/checkout.js";
import { findBillingAccount } from "../../services/subscriptions/accounts.js";
import { findUserByEmail, findUserById } from "../../services/main-services/user-service.js";
import { handleAlumniSignup, handleUserSignup, handleGuestTicketPurchase, handleMemberTicketPurchase } from "../../services/main-services/stripe-webhook-service.js";

// Support checkouts opened before deployment, but derive plan/tier/period from
// Stripe prices and never replace another running subscription by customer ID.
async function completeLegacyMembership(session, region) {
  const subscriptionId = stripeId(session.subscription);
  const customerId = stripeId(session.customer);
  const { state, sub } = await readStripeSubscription(createStripeClient(region), subscriptionId);
  if (stripeId(sub.customer) !== customerId || !state.plan) throw new Error("Unrecognized membership checkout");
  const metadata = { ...session.metadata, tier: state.plan.tier, period: state.plan.period };
  const paymentData = { subscriptionId, customerId, paymentStatus: session.payment_status, stripeRegion: region };
  let user = await findBillingAccount({ "subscription.id": subscriptionId });
  if (!user) {
    if (["signup", "alumni-signup"].includes(metadata.method)) {
      if (await findUserByEmail(metadata.email)) throw new Error("Signup email already has an account; manual reconciliation required");
      await (state.plan.type === "alumni" ? handleAlumniSignup : handleUserSignup)(metadata, paymentData);
    } else {
      user = await findUserById(metadata.userId);
      if (!user) throw new Error("Membership account not found");
      if (user.subscription?.id && user.subscription.id !== subscriptionId) {
        const previous = await reconcileAccount(user);
        if (!previous?.state.ended) throw new Error("Refusing to replace a running subscription; manual reconciliation required");
        user = previous.user;
      }
      user.subscription = { id: subscriptionId, customerId, stripeRegion: region, period: state.plan.period };
      if (["active", "locked", "payment_awaiting"].includes(user.status)) user.status = "payment_awaiting";
      await user.save();
    }
  }
  await reconcileSubscription(subscriptionId, region, { expectedCustomerId: customerId });
}

export const postWebhookCheckout = async (req, res, next) => {
  const requestedRegion = req.query.region ?? "netherlands";
  if (!Object.hasOwn(STRIPE_KEYS, requestedRegion)) return res.status(400).json({ message: "Unknown Stripe account" });
  let event, stripe, region;
  try {
    stripe = createStripeClient(requestedRegion);
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], getStripeKey("webhookSecretKey", requestedRegion));
    region = canonicalStripeRegion(requestedRegion);
  } catch { return res.status(400).json({ message: "Invalid Stripe webhook signature or configuration" }); }
  try {
    const object = event.data.object;
    await captureMemberRevenueEvent(event, region, { stripe });
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
      const session = await stripe.checkout.sessions.retrieve(object.id);
      if (["paid", "no_payment_required"].includes(session.payment_status) ||
          (session.mode === "subscription" && session.status === "complete" && session.subscription)) {
        const key = `checkout-event:${region}:${session.id}`;
        await withBillingLease(key, async ({ record }) => {
          if (record.completedAt || session.metadata?.bgsnlFulfilled === "1") return;
          if (session.mode === "subscription") {
            if (session.metadata?.method === "membership_checkout") await completeMembershipCheckout(session, region);
            else if (["signup", "alumni-signup", "alumni_migration", "unlock_account"].includes(session.metadata?.method)) {
              await completeLegacyMembership(session, region);
            }
          } else if (session.mode === "payment") {
            const data = { transactionId: stripeId(session.payment_intent) || session.id, stripeRegion: region };
            if (session.metadata?.method === "buy_guest_ticket") await handleGuestTicketPurchase(session.metadata, data);
            if (session.metadata?.method === "buy_member_ticket") await handleMemberTicketPurchase(session.metadata, data);
          }
          await stripe.checkout.sessions.update(session.id, { metadata: { bgsnlFulfilled: "1" } });
          await BillingRecord.updateOne({ _id: key }, { $set: { completedAt: new Date() } }, { upsert: true });
        });
      }
    } else if (event.type.startsWith("customer.subscription.") || event.type.startsWith("invoice.")) {
      const subscriptionId = event.type.startsWith("customer.subscription.") ? object.id : invoiceSubscriptionId(object);
      if (subscriptionId) await reconcileSubscription(subscriptionId, region, { expectedCustomerId: stripeId(object.customer) });
    }
    // Never log or reflect checkout metadata (legacy sessions may contain PII).
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Stripe webhook will be retried", { eventId: event.id, type: event.type, code: error.code });
    return next(new HttpError("Webhook processing is temporarily unavailable. Please retry.", 503));
  }
};
