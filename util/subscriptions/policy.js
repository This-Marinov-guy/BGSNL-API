import {
  ALUMNI, MEMBER, LIMITLESS_ACCOUNT, SUBSCRIPTIONS, ALUMNI_TIER_BY_PRICE_ID,
  ALUMNI_PRICE_TIER_1, ALUMNI_PRICE_TIER_2, ALUMNI_PRICE_TIER_3, ALUMNI_PRICE_TIER_4,
} from "../config/defines.js";

export const ARCHIVED_ACCOUNT_STATUSES = ["alumni-migrated", "membership_active", "membership-migrated"];
export const CURRENT_ACCOUNT_FILTER = { status: { $nin: ARCHIVED_ACCOUNT_STATUSES } };
export const ENDED_SUBSCRIPTION_STATUSES = ["canceled", "incomplete_expired"];
export const FREE_ALUMNI_PLAN = { priceId: "alumni_free", type: "alumni", tier: 0, period: 0, amount: 0, currency: "eur", label: "Alumni · Tier 0 (no paid benefits)" };
export const MEMBERSHIP_PLANS = [
  ...SUBSCRIPTIONS.map(({ id, period, amount }) => ({
    priceId: id, type: MEMBER, period, amount, label: `Member · ${period} months`,
  })),
  ...[ALUMNI_PRICE_TIER_1, ALUMNI_PRICE_TIER_2, ALUMNI_PRICE_TIER_3, ALUMNI_PRICE_TIER_4]
    .map((priceId, index) => ({
      priceId, type: ALUMNI, period: 1, tier: index + 1,
      label: `Alumni · Tier ${index + 1}`,
    })),
];

export const stripeId = (value) => typeof value === "string" ? value : value?.id;
export const invoiceSubscriptionId = (invoice) => stripeId(
  invoice?.subscription || invoice?.parent?.subscription_details?.subscription
);
export const planForPrice = (id, { selectable = false } = {}) => {
  const current = MEMBERSHIP_PLANS.find((plan) => plan.priceId === id);
  if (current || selectable) return current || null;
  const tier = ALUMNI_TIER_BY_PRICE_ID[id];
  return tier ? { priceId: id, type: ALUMNI, period: 1, tier, label: `Alumni · Tier ${tier}` } : null;
};
export const accountType = (user) => user?.roles?.includes(ALUMNI) ? ALUMNI : MEMBER;

export function subscriptionState(subscription, unpaidInvoices = [], now = Date.now(), paidInvoices = []) {
  const items = subscription.items?.data || [];
  const plan = items.length === 1 && items[0].quantity === 1
    ? planForPrice(stripeId(items[0].price)) : null;
  const latest = typeof subscription.latest_invoice === "object" ? subscription.latest_invoice : null;
  const outstandingInvoices = unpaidInvoices.filter((invoice) =>
    invoiceSubscriptionId(invoice) === subscription.id && invoice.amount_remaining > 0 &&
    ["open", "uncollectible"].includes(invoice.status)
  );
  // A processing invoice must not hide a different failed invoice.
  const outstanding = outstandingInvoices.find((invoice) => invoice.attempted && invoice.payment_intent?.status !== "processing") || outstandingInvoices[0];
  const processing = outstanding?.payment_intent?.status === "processing";
  const ended = ENDED_SUBSCRIPTION_STATUSES.includes(subscription.status);
  const paymentFailed = !ended && ((!!outstanding?.attempted && !processing) || ["past_due", "unpaid"].includes(subscription.status));
  const trial = subscription.status === "trialing" && subscription.trial_end * 1000 > now;
  const periodEnd = subscription.current_period_end ?? items[0]?.current_period_end;
  // An expired/abandoned pending update can leave latest_invoice void while
  // the original plan is still paid. Require evidence for this exact item,
  // price and full remaining period, never merely a historical paid invoice.
  const paidCoverage = latest?.status === "void" && !subscription.pending_update && paidInvoices.some((invoice) =>
    invoice.status === "paid" && invoiceSubscriptionId(invoice) === subscription.id &&
    invoice.lines?.data?.some((line) =>
      stripeId(line.subscription_item || line.parent?.subscription_item_details?.subscription_item) === items[0]?.id &&
      stripeId(line.price || line.pricing?.price_details?.price) === plan?.priceId &&
      line.amount >= 0 && line.period?.start * 1000 <= now && line.period?.end >= periodEnd)
  );
  const paid = subscription.status === "active" && (latest?.status === "paid" || paidCoverage);
  const hasBenefits = !!plan && !subscription.pause_collection && !outstanding && !paymentFailed && !ended &&
    (paid || trial) && periodEnd * 1000 > now;
  const lockReason = hasBenefits ? null : ended ? "subscription_ended"
    : paymentFailed ? "payment_failed" : !plan ? "unsupported_plan"
      : subscription.pause_collection || subscription.status === "paused" ? "subscription_paused" : "payment_pending";
  return {
    plan, hasBenefits, lockReason, paymentFailed,
    failureInvoiceId: outstanding?.id || (paymentFailed ? stripeId(subscription.latest_invoice) : null),
    reminderNeeded: paymentFailed && !processing && (outstanding?.attempted || ["past_due", "unpaid"].includes(subscription.status)),
    ended, periodEnd,
    periodStart: subscription.current_period_start ?? items[0]?.current_period_start,
  };
}

// Token claims and browser state are never used to grant benefits.
export function accountEntitlements(user, now = Date.now()) {
  const isAlumni = accountType(user) === ALUMNI;
  const sub = user?.subscription;
  const hasSubscription = !!sub?.id;
  const fresh = sub?.syncedAt && now - new Date(sub.syncedAt).getTime() < 5 * 60 * 1000;
  const legacyAccess = !hasSubscription && (user?.roles?.some((role) => LIMITLESS_ACCOUNT.includes(role)) ||
    new Date(user?.expireDate).getTime() > now);
  const hasBenefits = user?.status === "active" && !(isAlumni && user?.tier === 0) &&
    (hasSubscription ? !!fresh && sub.hasBenefits === true && new Date(user.expireDate).getTime() > now : !!legacyAccess);
  return {
    isAlumni, tier: isAlumni ? user?.tier ?? 0 : null,
    isSubscribed: hasSubscription && !ENDED_SUBSCRIPTION_STATUSES.includes(sub.status),
    hasBenefits, memberDiscount: hasBenefits && !isAlumni,
    billingLocked: hasSubscription && !!sub.lockReason,
    lockReason: sub?.lockReason || (!hasBenefits && user?.status === "locked" ? "membership_expired" : null),
    status: user?.status,
  };
}
