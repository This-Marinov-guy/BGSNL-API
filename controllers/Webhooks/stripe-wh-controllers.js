import HttpError from "../../models/Http-error.js";
import { captureMemberRevenueEvent } from "../../services/subscriptions/revenue-sharing.js";
import BillingRecord from "../../models/BillingRecord.js";
import { createStripeClient, getStripeKey, STRIPE_KEYS } from "../../util/config/stripe.js";
import { stripeId, invoiceSubscriptionId } from "../../util/subscriptions/policy.js";
import { withBillingLease } from "../../services/subscriptions/lease.js";
import { withWebhookBillingRetries } from "../../services/subscriptions/lease-retry.js";
import { canonicalStripeRegion, reconcileSubscription, reconcileAccount, readStripeSubscription } from "../../services/subscriptions/reconcile.js";
import { completeMembershipCheckout } from "../../services/subscriptions/checkout.js";
import { resolveCheckoutAccount } from "../../services/subscriptions/checkout-account.js";
import { persistSubscriptionAccount } from "../../services/subscriptions/accounts.js";
import { handleAlumniSignup, handleUserSignup, handleGuestTicketPurchase, handleMemberTicketPurchase } from "../../services/main-services/stripe-webhook-service.js";
import { logIntegrationError } from "../../middleware/axiom-logger.js";
import { flagLateMembershipPayment, recoverCanceledMembershipInvoices } from "../../services/subscriptions/invoice-recovery.js";

async function markCheckoutFulfilled(stripe, sessionId, region) {
  const metadata = { bgsnlFulfilled: "1" };
  if (typeof stripe.checkout.sessions.update === "function") {
    await stripe.checkout.sessions.update(sessionId, { metadata });
    return;
  }
  // The pinned Stripe SDK predates Checkout Session updates. Use the same
  // Stripe API directly until the SDK can be upgraded across the API.
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getStripeKey("secretKey", region)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2022-08-01",
      "Idempotency-Key": `bgsnl-fulfilled:${sessionId}`,
    },
    body: new URLSearchParams({ "metadata[bgsnlFulfilled]": "1" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Stripe checkout metadata update failed (${response.status})`);
}

// Support checkouts opened before deployment, but derive plan/tier/period from
// Stripe prices and never replace another running subscription by customer ID.
export async function completeLegacyMembership(session, region, {
  readSubscription = readStripeSubscription, stripeClient = createStripeClient,
  resolveAccount = resolveCheckoutAccount, reconcileExisting = reconcileAccount,
  persistAccount = persistSubscriptionAccount, reconcile = reconcileSubscription,
  signupMember = handleUserSignup, signupAlumni = handleAlumniSignup,
  assertOwned = async () => {},
} = {}) {
  const subscriptionId = stripeId(session.subscription);
  const customerId = stripeId(session.customer);
  const { state, sub } = await readSubscription(stripeClient(region), subscriptionId);
  if (stripeId(sub.customer) !== customerId || !state.plan) throw new Error("Unrecognized membership checkout");
  const metadata = { ...session.metadata, tier: state.plan.tier, period: state.plan.period };
  const paymentData = { subscriptionId, customerId, paymentStatus: session.payment_status, stripeRegion: region };
  let user = await resolveAccount({ subscriptionId, customerId, userId: metadata.userId, email: metadata.email });
  if (user) {
    if (user.subscription?.id !== subscriptionId) {
      if (user.subscription?.id) {
        const previous = await reconcileExisting(user);
        if (!previous?.state.ended) throw new Error("Refusing to replace a running subscription; manual reconciliation required");
        user = previous.user;
      }
      await persistAccount(user, {
        subscription: { id: subscriptionId, customerId, stripeRegion: region, period: state.plan.period },
        status: ["active", "locked", "payment_awaiting"].includes(user.status) ? "payment_awaiting" : user.status,
      }, null, assertOwned);
    }
  } else if (["signup", "alumni-signup"].includes(metadata.method)) {
    await assertOwned();
    await (state.plan.type === "alumni" ? signupAlumni : signupMember)(metadata, paymentData);
  } else {
    throw new Error("Membership account not found");
  }
  await reconcile(subscriptionId, region, { expectedCustomerId: customerId });
}

export const postWebhookCheckout = async (req, res, next) => {
  const requestedRegion = req.query.region ?? "netherlands";
  if (!Object.hasOwn(STRIPE_KEYS, requestedRegion)) return res.status(400).json({ message: "Unknown Stripe account" });
  let event, stripe, region;
  try {
    stripe = createStripeClient(requestedRegion);
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], getStripeKey("webhookSecretKey", requestedRegion));
    region = canonicalStripeRegion(requestedRegion);
    res.locals.verifiedWebhookEvent = { eventId: event.id, eventType: event.type, livemode: event.livemode };
  } catch { return res.status(400).json({ message: "Invalid Stripe webhook signature or configuration" }); }
  try {
    return await withWebhookBillingRetries(async () => {
      const object = event.data.object;
      await captureMemberRevenueEvent(event, region, { stripe });
      if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
        const session = await stripe.checkout.sessions.retrieve(object.id);
        if (["paid", "no_payment_required"].includes(session.payment_status) ||
            (session.mode === "subscription" && session.status === "complete" && session.subscription)) {
          const key = `checkout-event:${region}:${session.id}`;
          await withBillingLease(key, async ({ record, assertOwned }) => {
            if (record.completedAt || session.metadata?.bgsnlFulfilled === "1") return;
            if (session.mode === "subscription") {
              if (session.metadata?.method === "membership_checkout") await completeMembershipCheckout(session, region);
              else if (["signup", "alumni-signup", "alumni_migration", "unlock_account"].includes(session.metadata?.method)) {
                await completeLegacyMembership(session, region, { assertOwned });
              } else return;
            } else if (session.mode === "payment") {
              const data = { transactionId: stripeId(session.payment_intent) || session.id, stripeRegion: region };
              if (session.metadata?.method === "buy_guest_ticket") await handleGuestTicketPurchase(session.metadata, data);
              else if (session.metadata?.method === "buy_member_ticket") await handleMemberTicketPurchase(session.metadata, data);
              else return;
            } else return;
            await markCheckoutFulfilled(stripe, session.id, region);
            await BillingRecord.updateOne({ _id: key }, { $set: { completedAt: new Date() } }, { upsert: true });
          });
        }
      } else if (event.type.startsWith("customer.subscription.") || event.type.startsWith("invoice.")) {
        const subscriptionId = event.type.startsWith("customer.subscription.") ? object.id : invoiceSubscriptionId(object);
        if (subscriptionId && event.type === "customer.subscription.deleted") {
          // A superseded subscription may no longer map to a current profile.
          // Its canceled renewal invoices must still become unpayable.
          const { sub, invoices } = await readStripeSubscription(stripe, subscriptionId);
          await recoverCanceledMembershipInvoices(stripe, sub, invoices, region);
        }
        if (subscriptionId && ["invoice.paid", "invoice.payment_succeeded"].includes(event.type)) {
          // An old invoice may no longer be attached to the account's current
          // subscription. It still needs durable review, not silent activation.
          const [invoice, sub] = await Promise.all([
            stripe.invoices.retrieve(object.id), stripe.subscriptions.retrieve(subscriptionId),
          ]);
          await flagLateMembershipPayment(stripe, sub, invoice, region);
        }
        if (subscriptionId) await reconcileSubscription(subscriptionId, region, { expectedCustomerId: stripeId(object.customer) });
      }
      // Never log or reflect checkout metadata (legacy sessions may contain PII).
      return res.status(200).json({ received: true });
    });
  } catch (error) {
    logIntegrationError("stripe", error, "webhook");
    console.error("Stripe webhook will be retried", { eventId: event.id, type: event.type, code: error.code });
    return next(new HttpError("Webhook processing is temporarily unavailable. Please retry.", 503));
  }
};
