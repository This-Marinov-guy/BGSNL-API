import { randomUUID } from "node:crypto";
import BillingRecord from "../../models/BillingRecord.js";
import HttpError from "../../models/Http-error.js";
import { planForPrice, planChangeChargesImmediately, stripeId } from "../../util/subscriptions/policy.js";
import { withBillingLease } from "./lease.js";
import { readStripeSubscription, reconcileAccount } from "./reconcile.js";
import { scheduleAlumniDowngrade } from "./scheduled-change.js";
import { memberRegionMetadata } from "./member-region.js";

// Member periods change now; Alumni downgrades change at renewal. Neither path
// uses the portal's immediately-invoiced flow.
export async function changePlanAtRenewal(user, plan, { stripe, region, memberRegion, dependencies = {} }) {
  const { withLease = withBillingLease, records = BillingRecord,
    readSubscription = readStripeSubscription, reconcile = reconcileAccount } = dependencies;
  const subscriptionId = user.subscription.id;
  const key = `subscription:${region}:${subscriptionId}`;
  await withLease(key, async ({ record, assertOwned }) => {
    const { sub, state } = await readSubscription(stripe, subscriptionId);
    const item = sub.items?.data?.[0];
    const current = state.plan;
    const selected = planForPrice(plan.priceId, { selectable: true });
    const downgrade = current?.type === "alumni" && selected?.type === "alumni" && selected.tier < current.tier;
    const retryingSchedule = downgrade && record.data?.downgrade?.priceId === selected.priceId;
    if (sub.id !== subscriptionId || stripeId(sub.customer) !== user.subscription.customerId) {
      throw new HttpError("Subscription ownership mismatch", 409);
    }
    if (user.status !== "active" || !state.hasBenefits || !["active", "trialing"].includes(sub.status) ||
        sub.pending_update || (sub.schedule && !retryingSchedule) || sub.cancel_at_period_end || sub.cancel_at || sub.pause_collection) {
      throw new HttpError("Resolve your payment, pending change or scheduled cancellation in Payments before changing plans.", 409);
    }
    if (!selected || !current || planChangeChargesImmediately(current, selected)) {
      throw new HttpError("Your subscription changed. Refresh and select your plan again.", 409);
    }
    // A retry after a lost response must reconcile, not reapply or bill again.
    if (current.priceId === selected.priceId) return;
    const price = await stripe.prices.retrieve(selected.priceId);
    const months = price.recurring?.interval === "year" ? price.recurring.interval_count * 12
      : price.recurring?.interval === "month" ? price.recurring.interval_count : null;
    if (!price.active || price.currency !== "eur" || !(price.unit_amount > 0) || months !== selected.period) {
      throw new HttpError("This membership plan is unavailable", 409);
    }
    const renewal = state.periodEnd;
    if (!Number.isSafeInteger(renewal) || renewal * 1000 <= Date.now()) {
      throw new HttpError("Your subscription is renewing. Please try again shortly.", 409);
    }
    if (downgrade) {
      await scheduleAlumniDowngrade({ stripe, sub, current, selected, renewal, key, record, records, assertOwned });
      return;
    }
    const intervalChanged = item.price?.recurring?.interval !== price.recurring.interval ||
      item.price?.recurring?.interval_count !== price.recurring.interval_count;
    const params = {
      ...(memberRegion ? { metadata: memberRegionMetadata(memberRegion, selected.priceId) } : {}),
      items: [{ id: item.id, price: selected.priceId, quantity: 1 }],
      proration_behavior: "none", payment_behavior: "error_if_incomplete",
      // Stripe otherwise resets the anchor and charges immediately when an
      // interval changes. This paid-through bridge keeps the existing renewal
      // date; Stripe may issue a zero-value invoice and report `trialing`.
      ...(intervalChanged ? { trial_end: renewal } : { billing_cycle_anchor: "unchanged" }),
    };
    const previous = record.data?.planChange;
    const pending = previous && !previous.completed && previous.priceId !== current.priceId;
    if (pending && (previous.priceId !== selected.priceId || previous.fromPriceId !== current.priceId || previous.renewal !== renewal ||
        previous.params?.metadata?.bgsnlMemberRegion !== memberRegion)) {
      throw new HttpError("Another plan change is still being processed. Please retry that change or contact support.", 409);
    }
    const operation = pending ? previous : {
      id: randomUUID(), fromPriceId: current.priceId, priceId: selected.priceId, renewal, params,
    };
    await assertOwned();
    await records.updateOne({ _id: key }, { $set: { "data.planChange": operation } }, { upsert: true });
    await stripe.subscriptions.update(subscriptionId, operation.params, { idempotencyKey: `plan-change:${operation.id}` });
    await assertOwned();
    await records.updateOne({ _id: key }, { $set: { "data.planChange.completed": true } });
  });
  // Outside the lease: reconciliation takes the same subscription lock and
  // persists tier/period/benefits now, without waiting for a renewal webhook.
  await reconcile(user);
  return { updated: true };
}
