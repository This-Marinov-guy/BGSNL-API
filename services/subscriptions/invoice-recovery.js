import { DEFAULT_REGION } from "../../util/config/defines.js";
import { invoiceSubscriptionId, planForPrice, stripeId } from "../../util/subscriptions/policy.js";

// Only central membership billing is covered by this policy. Ticket invoices,
// regional billing, partial payments, adjustments and genuine debts are not.
export function obsoleteRenewalInvoice(sub, invoice, region) {
  const item = sub.items?.data?.[0];
  const lines = invoice.lines?.data || [];
  return region === DEFAULT_REGION && sub.status === "canceled" &&
    sub.cancellation_details?.reason === "payment_failed" && !!sub.ended_at &&
    sub.items?.data?.length === 1 && item.quantity === 1 && !!planForPrice(stripeId(item.price)) &&
    invoiceSubscriptionId(invoice) === sub.id && stripeId(invoice.customer) === stripeId(sub.customer) &&
    invoice.status === "open" && invoice.billing_reason === "subscription_cycle" && invoice.attempted === true &&
    invoice.amount_paid === 0 && invoice.amount_remaining > 0 && invoice.amount_remaining === invoice.amount_due &&
    invoice.starting_balance === 0 && !invoice.pre_payment_credit_notes_amount && !invoice.post_payment_credit_notes_amount &&
    !invoice.metadata?.bgsnlPreserveDebt && !invoice.lines?.has_more && lines.length === 1 &&
    invoice.payment_intent?.status !== "processing" &&
    lines.every(line => line.type === "subscription" && line.proration === false && line.amount > 0 &&
      invoiceSubscriptionId(line) === sub.id && stripeId(line.subscription_item) === item.id &&
      stripeId(line.price) === stripeId(item.price) && line.period?.start === sub.current_period_start &&
      line.period?.end === sub.current_period_end && line.period.start <= sub.ended_at && sub.ended_at < line.period.end);
}

export function lateCanceledPayment(sub, invoice, region) {
  return region === DEFAULT_REGION && sub.status === "canceled" && !!sub.ended_at &&
    sub.items?.data?.length === 1 && !!planForPrice(stripeId(sub.items.data[0].price)) &&
    invoiceSubscriptionId(invoice) === sub.id && stripeId(invoice.customer) === stripeId(sub.customer) &&
    invoice.status === "paid" && invoice.amount_paid > 0 && invoice.status_transitions?.paid_at > sub.ended_at;
}

export async function flagLateMembershipPayment(stripe, sub, invoice, region) {
  if (!lateCanceledPayment(sub, invoice, region) || invoice.metadata?.bgsnlLatePaymentReview) return false;
  // Durable and visible on the invoice, including after our short-lived jobs
  // expire or the account moves to a different subscription. No new charge,
  // recurring contract, automatic refund or silent reassignment of money.
  await stripe.invoices.update(invoice.id, { metadata: {
    bgsnlLatePaymentReview: "pending",
    bgsnlLatePaymentAction: "Contact customer: offer credit toward a new term or refund; do not restart renewal without consent.",
  } }, { idempotencyKey: `late-membership-payment:v1:${invoice.id}` });
  console.warn("Late membership payment needs credit/refund review", { invoiceId: invoice.id, subscriptionId: sub.id, reviewStatus: "pending" });
  return true;
}

export async function recoverCanceledMembershipInvoices(stripe, sub, invoices, region) {
  if (region !== DEFAULT_REGION || sub.status !== "canceled") return false;
  let changed = false;
  if (typeof sub.latest_invoice === "object" && sub.latest_invoice) {
    await flagLateMembershipPayment(stripe, sub, sub.latest_invoice, region);
  }
  for (const candidate of invoices || []) {
    if (!obsoleteRenewalInvoice(sub, candidate, region)) continue;
    // Refresh just before the irreversible operation. A payment may have
    // succeeded since the list call; never void a paid/processing invoice.
    const invoice = await stripe.invoices.retrieve(candidate.id, { expand: ["payment_intent"] });
    if (!obsoleteRenewalInvoice(sub, invoice, region)) {
      await flagLateMembershipPayment(stripe, sub, invoice, region);
      changed = true;
      continue;
    }
    try {
      await stripe.invoices.voidInvoice(invoice.id, {}, { idempotencyKey: `obsolete-membership-renewal:v1:${invoice.id}` });
    } catch (error) {
      // Payment and void can race at the provider. Only accept a confirmed
      // terminal state; transient/ambiguous failures must retry the webhook.
      const current = await stripe.invoices.retrieve(invoice.id);
      if (!["paid", "void"].includes(current.status)) throw error;
      await flagLateMembershipPayment(stripe, sub, current, region);
    }
    changed = true;
  }
  return changed;
}
