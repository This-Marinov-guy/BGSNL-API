import HttpError from "../../models/Http-error.js";
import { createStripeClient } from "../../util/config/stripe.js";
import { invoiceSubscriptionId, stripeId } from "../../util/subscriptions/policy.js";
import { readStripeSubscription, resolveSubscriptionRegion } from "./reconcile.js";

const PAYMENT_REASONS = {
  insufficient_funds: "The payment method had insufficient funds. Review your payment method in billing.",
  expired_card: "The card used for your membership has expired. Update your payment method in billing.",
  authentication_required: "Your bank requires payment authentication. Open billing to complete the required steps.",
  authentication_not_handled: "Your bank requires payment authentication. Open billing to complete the required steps.",
  incorrect_cvc: "The card security code could not be verified. Review your payment details in billing.",
  card_declined: "The payment was declined. Review your payment method or contact your bank.",
};
const MISSING = { reason: "no_membership", title: "No active subscription", description: "Choose a subscription to start your membership." };

// Read-only, authenticated diagnostics. Never changes benefits, retries a charge,
// or exposes raw Stripe errors, payment methods or client secrets.
export async function readBillingDetails(user, { resolveRegion = resolveSubscriptionRegion, stripeForRegion = createStripeClient, readSubscription = readStripeSubscription } = {}) {
  if (!user) throw new HttpError("Authentication required", 401);
  if (!["active", "locked", "payment_awaiting"].includes(user.status)) {
    return { reason: "account_restricted", title: "Your account needs support", description: "This account has an administrative restriction. Paying for a membership will not remove it. Please contact support." };
  }
  if (!user.subscription?.id) return { ...MISSING };
  const region = await resolveRegion(user);
  const stripe = stripeForRegion(region);
  const result = await readSubscription(stripe, user.subscription.id);
  const { sub, state, invoices = [] } = result;
  if (sub.id !== user.subscription.id || !user.subscription.customerId || stripeId(sub.customer) !== user.subscription.customerId) {
    throw new HttpError("We could not verify billing ownership. Please contact support.", 503);
  }
  if (state.hasBenefits) return { reason: "account_sync_pending", title: "Your membership payment is confirmed", description: "We have confirmed your membership payment. Your account is refreshing; if it remains locked, contact support. Do not start another payment." };
  if (state.lockReason === "payment_failed") {
    const invoice = invoices.find((item) => item.id === state.failureInvoiceId) ||
      (sub.latest_invoice?.id === state.failureInvoiceId ? sub.latest_invoice : null);
    const ownedInvoice = invoice && invoiceSubscriptionId(invoice) === sub.id && stripeId(invoice.customer) === user.subscription.customerId ? invoice : null;
    const error = ownedInvoice?.payment_intent?.last_payment_error;
    const code = error?.decline_code || error?.code;
    return { reason: "payment_failed", title: "Your membership payment was unsuccessful",
      description: PAYMENT_REASONS[code] || "Your membership payment is still unpaid. Open billing to review the invoice and payment method.",
      paymentNote: "Benefits return after payment is confirmed. Cancelling does not settle an outstanding invoice.",
      ...(ownedInvoice && Number.isSafeInteger(ownedInvoice.amount_remaining) && /^[a-z]{3}$/.test(ownedInvoice.currency)
        ? { amountDue: ownedInvoice.amount_remaining, currency: ownedInvoice.currency } : {}),
    };
  }
  const notices = {
    subscription_ended: { title: "No active subscription", description: "Renew your previous subscription or choose another plan to restore paid benefits." },
    subscription_paused: { title: "Your membership is paused", description: "Your subscription or payment collection is paused. Review billing or contact support to restore your membership." },
    unsupported_plan: { title: "Your membership plan needs review", description: "The subscription linked to this account does not match a supported membership plan. Contact support before making another payment." },
    payment_pending: { title: "Your membership payment is not confirmed", description: "We have not confirmed your membership payment yet. Review billing for any required steps. If payment is processing, wait before paying again." },
  };
  return { reason: state.lockReason || "payment_pending", ...(notices[state.lockReason] || notices.payment_pending) };
}
