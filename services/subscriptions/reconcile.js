import { registerMemberRevenueSubscription } from "./revenue-sharing.js";
import { hasMemberConnectAllocation } from "./connected.js";
import { randomUUID } from "node:crypto";
import BillingAttention from "../../models/BillingAttention.js";
import { createStripeClient, STRIPE_KEYS } from "../../util/config/stripe.js";
import { DEFAULT_REGION } from "../../util/config/defines.js";
import { stripeId, subscriptionState, CURRENT_ACCOUNT_FILTER, accountType } from "../../util/subscriptions/policy.js";
import { withBillingLease } from "./lease.js";
import { findBillingAccount, persistSubscriptionAccount } from "./accounts.js";
import { membershipReportingSnapshot, refreshMembershipReporting } from "./reporting.js";

export function canonicalStripeRegion(region = DEFAULT_REGION) {
  const key = STRIPE_KEYS[region]?.secretKey;
  if (!key) throw new Error("Stripe account is not configured");
  return Object.keys(STRIPE_KEYS).find((name) => name === DEFAULT_REGION && STRIPE_KEYS[name].secretKey === key) ||
    Object.keys(STRIPE_KEYS).find((name) => STRIPE_KEYS[name].secretKey === key);
}

export async function resolveSubscriptionRegion(user) {
  if (user.subscription?.stripeRegion) return canonicalStripeRegion(user.subscription.stripeRegion);
  // Legacy memberships did not record their Stripe account. Only a successful
  // retrieval AND customer match can establish ownership in an account.
  const regions = [...new Set([DEFAULT_REGION, user.region, ...Object.keys(STRIPE_KEYS)].filter((r) => STRIPE_KEYS[r]?.secretKey)
    .map(canonicalStripeRegion))];
  for (const region of regions) {
    try {
      const sub = await createStripeClient(region).subscriptions.retrieve(user.subscription.id);
      if (stripeId(sub.customer) !== user.subscription.customerId) throw new Error("Subscription customer mismatch");
      return region;
    } catch (error) { if (error.code !== "resource_missing") throw error; }
  }
  throw new Error("Subscription could not be located in the configured Stripe accounts");
}

export async function readStripeSubscription(stripe, id) {
  const sub = await stripe.subscriptions.retrieve(id, { expand: ["latest_invoice.payment_intent"] });
  const invoices = [];
  // An older unpaid invoice must not be hidden by a newer paid invoice.
  for (const status of ["open", "uncollectible"]) {
    for await (const invoice of stripe.invoices.list({ subscription: id, status, limit: 100, expand: ["data.payment_intent"] })) invoices.push(invoice);
  }
  let state = subscriptionState(sub, invoices);
  if (!state.hasBenefits && !invoices.length && sub.status === "active" && sub.latest_invoice?.status === "void" && !sub.pending_update) {
    for await (const invoice of stripe.invoices.list({ subscription: id, status: "paid", limit: 100 })) {
      if (invoice.lines?.has_more) {
        const lines = [];
        for await (const line of stripe.invoices.listLineItems(invoice.id, { limit: 100 })) lines.push(line);
        invoice.lines = { data: lines };
      }
      state = subscriptionState(sub, invoices, Date.now(), [invoice]);
      if (state.hasBenefits) break;
    }
  }
  return { sub, state, invoices };
}

export async function reconcileSubscription(subscriptionId, region, { expectedCustomerId, dependencies = {} } = {}) {
  region = canonicalStripeRegion(region);
  const {
    withLease = withBillingLease, findAccount = findBillingAccount,
    readSubscription = readStripeSubscription, persistAccount = persistSubscriptionAccount,
    readRevenueAllocation = registerMemberRevenueSubscription, attention = BillingAttention, stripe = createStripeClient(region), onChanged = refreshMembershipReporting,
  } = dependencies;
  return withLease(`subscription:${region}:${subscriptionId}`, async ({ assertOwned }) => {
    const user = await findAccount({ "subscription.id": subscriptionId });
    if (!user) return null; // Checkout can arrive after invoice.paid; checkout reconciles again.
    const previousReporting = membershipReportingSnapshot(user);
    if (user.subscription.stripeRegion && canonicalStripeRegion(user.subscription.stripeRegion) !== region) return null;
    const { sub, state } = await readSubscription(stripe, subscriptionId);
    if (stripeId(sub.customer) !== user.subscription.customerId ||
        (expectedCustomerId && stripeId(sub.customer) !== expectedCustomerId)) throw new Error("Subscription ownership mismatch");
    const now = new Date();
    let episode = user.subscription.failureEpisode;
    if (!episode && state.reminderNeeded) {
      const reminder = await attention.findOneAndUpdate({ subscriptionId, stripeRegion: region, resolvedAt: null }, { $setOnInsert: {
        _id: episode || randomUUID(),
        subscriptionId, stripeRegion: region, invoiceId: state.failureInvoiceId,
        startedAt: now, nextAttemptAt: now, resolvedAt: null,
      } }, { upsert: true, new: true });
      episode = reminder._id;
      // Keep the current episode ID on the account after its Redis job expires.
      // Reconciliation must not recreate it and repeat the same reminders.
    } else if (episode && !state.paymentFailed && !state.reminderNeeded && (state.hasBenefits || state.ended)) {
      await attention.updateOne({ _id: episode }, { $set: { resolvedAt: now }, $unset: { nextAttemptAt: 1 } });
      episode = undefined;
    }
    const subscription = {
      ...user.subscription.toObject(), id: sub.id, customerId: stripeId(sub.customer), stripeRegion: region,
      status: sub.status, priceId: state.plan?.priceId,
      period: state.plan?.period || user.subscription.period,
      hasBenefits: state.hasBenefits, lockReason: state.lockReason,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
      currentPeriodStart: state.periodStart ? new Date(state.periodStart * 1000) : null,
      currentPeriodEnd: state.periodEnd ? new Date(state.periodEnd * 1000) : null,
      pendingUpdate: !!sub.pending_update, syncedAt: now, lastAttemptAt: now, failureEpisode: episode,
      // A successful paid plan change supersedes an abandoned free-tier request.
      freeAlumniRequested: user.subscription.freeAlumniRequested &&
        !(state.hasBenefits && (user.subscription.freeAlumniPriceId || user.subscription.priceId) &&
          (user.subscription.freeAlumniPriceId || user.subscription.priceId) !== state.plan?.priceId),
    };
    // Billing recovery cannot lift an administrative suspension.
    const canSetStatus = ["active", "locked", "payment_awaiting"].includes(user.status);
    const freeAlumni = state.ended && subscription.freeAlumniRequested && canSetStatus;
    if (freeAlumni) subscription.lockReason = null;
    const fields = { subscription,
      status: canSetStatus ? state.hasBenefits || freeAlumni ? "active" : "locked" : user.status,
      ...(subscription.currentPeriodStart ? { purchaseDate: subscription.currentPeriodStart } : {}),
      ...(subscription.currentPeriodEnd ? { expireDate: subscription.currentPeriodEnd } : {}),
    };
    const plan = freeAlumni ? { type: "alumni", tier: 0 } : state.hasBenefits && canSetStatus ? state.plan : null;
    subscription.connected = (plan?.type || accountType(user)) === "member" && state.plan?.type === "member" &&
      hasMemberConnectAllocation(subscription, await readRevenueAllocation(sub));
    const saved = await persistAccount(user, fields, plan, assertOwned);
    if (previousReporting !== membershipReportingSnapshot(saved)) {
      // Exports are ancillary: they must never roll back a committed billing change.
      try { await onChanged(saved); }
      catch { console.error("Membership reporting refresh could not be queued", { accountId: saved.id }); }
    }
    return { user: saved, sub, state, stripe, region };
  });
}

export async function reconcileAccount(user) {
  if (!user?.subscription?.id || CURRENT_ACCOUNT_FILTER.status.$nin.includes(user.status)) return { user };
  return reconcileSubscription(user.subscription.id, await resolveSubscriptionRegion(user), {
    expectedCustomerId: user.subscription.customerId,
  });
}
