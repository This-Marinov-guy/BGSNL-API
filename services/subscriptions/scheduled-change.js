import { randomUUID } from "node:crypto";
import HttpError from "../../models/Http-error.js";
import BillingRecord from "../../models/BillingRecord.js";
import { planForPrice, stripeId } from "../../util/subscriptions/policy.js";

// Copy writable settings from the pinned Stripe API, not read-only phase data.
// Omitting a configured phase setting would silently reset it in Stripe.
function phaseSettings(phase) {
  if (phase.add_invoice_items?.length) throw new HttpError("This subscription needs support to schedule a change.", 409);
  const settings = {};
  for (const key of ["application_fee_percent", "billing_cycle_anchor", "billing_thresholds", "collection_method", "currency", "description", "metadata"]) {
    if (phase[key] != null) settings[key] = phase[key];
  }
  for (const key of ["coupon", "default_payment_method", "on_behalf_of"]) {
    if (phase[key]) settings[key] = stripeId(phase[key]);
  }
  if (phase.default_tax_rates) settings.default_tax_rates = phase.default_tax_rates.map(stripeId);
  if (phase.automatic_tax) settings.automatic_tax = { enabled: phase.automatic_tax.enabled };
  if (phase.invoice_settings) settings.invoice_settings = {
    ...(phase.invoice_settings.days_until_due != null ? { days_until_due: phase.invoice_settings.days_until_due } : {}),
    ...(phase.invoice_settings.account_tax_ids ? { account_tax_ids: phase.invoice_settings.account_tax_ids.map(stripeId) } : {}),
  };
  if (phase.transfer_data) settings.transfer_data = { ...phase.transfer_data, destination: stripeId(phase.transfer_data.destination) };
  return settings;
}

export async function scheduleAlumniDowngrade({ stripe, sub, current, selected, renewal, key, record, records, assertOwned }) {
  const previous = record.data?.downgrade;
  const operation = previous && previous.priceId === selected.priceId && previous.fromPriceId === current.priceId && previous.renewal === renewal
    ? previous : { id: randomUUID(), priceId: selected.priceId, fromPriceId: current.priceId, renewal };
  if (sub.schedule && operation !== previous) throw new HttpError("A subscription change is already scheduled. Please contact support.", 409);
  await assertOwned();
  await records.updateOne({ _id: key }, { $set: { "data.downgrade": operation } }, { upsert: true });
  // Replaying creation with the same key also recovers a lost creation response.
  const schedule = operation.scheduleId
    ? await stripe.subscriptionSchedules.retrieve(operation.scheduleId)
    : await stripe.subscriptionSchedules.create({ from_subscription: sub.id }, { idempotencyKey: `downgrade-create:${operation.id}` });
  if (stripeId(schedule.subscription) !== sub.id || stripeId(schedule.customer) !== stripeId(sub.customer) ||
      (sub.schedule && stripeId(sub.schedule) !== schedule.id) || schedule.status !== "active") {
    throw new HttpError("Subscription schedule could not be verified. Please contact support.", 409);
  }
  if (schedule.metadata?.bgsnlDowngradeOperation === operation.id) return;
  const phase = schedule.phases?.[0];
  if (schedule.phases?.length !== 1 || phase.items?.length !== 1 ||
      stripeId(phase.items[0].price) !== current.priceId || phase.items[0].quantity !== 1 ||
      phase.start_date > Date.now() / 1000 || phase.end_date !== renewal) {
    throw new HttpError("Subscription schedule changed. Please contact support.", 409);
  }
  const settings = phaseSettings(phase);
  const item = phase.items[0];
  const itemSettings = {
    ...(item.tax_rates ? { tax_rates: item.tax_rates.map(stripeId) } : {}),
    ...(item.billing_thresholds ? { billing_thresholds: item.billing_thresholds } : {}),
    ...(item.metadata ? { metadata: item.metadata } : {}),
  };
  operation.scheduleId = schedule.id;
  operation.params = operation.params || {
    end_behavior: "release", proration_behavior: "none",
    metadata: { bgsnlDowngradeOperation: operation.id, bgsnlNextPrice: selected.priceId, bgsnlChangeAt: String(renewal) },
    phases: [
      { ...settings, start_date: phase.start_date, end_date: renewal,
        ...(phase.trial_end ? { trial_end: phase.trial_end } : {}),
        items: [{ ...itemSettings, price: current.priceId, quantity: 1 }], proration_behavior: "none" },
      { ...settings, start_date: renewal, iterations: 1,
        items: [{ ...itemSettings, price: selected.priceId, quantity: 1 }], proration_behavior: "none" },
    ],
  };
  await assertOwned();
  await records.updateOne({ _id: key }, { $set: { "data.downgrade": operation } });
  await stripe.subscriptionSchedules.update(schedule.id, operation.params, { idempotencyKey: `downgrade-update:${operation.id}` });
}

// Run under the subscription lease. Only our own completed downgrade schedules
// are released; external schedules are never modified. Releasing leaves the
// subscription running at its new price and permits subsequent plan changes.
export async function syncScheduledChange(stripe, sub, state, assertOwned, { record, key, records = BillingRecord } = {}) {
  if (!sub.schedule) return null;
  let schedule = await stripe.subscriptionSchedules.retrieve(stripeId(sub.schedule));
  if (stripeId(schedule.subscription) !== sub.id || stripeId(schedule.customer) !== stripeId(sub.customer)) {
    throw new Error("Subscription schedule ownership mismatch");
  }
  const pending = record?.data?.downgrade;
  const selected = planForPrice(pending?.priceId, { selectable: true });
  // Recover a request interrupted between creating and configuring a schedule.
  // Its persisted operation and Stripe idempotency key must still prove which
  // schedule was requested; never adopt an unrelated external schedule.
  if (!schedule.metadata?.bgsnlDowngradeOperation && pending && key && state.hasBenefits &&
      state.plan?.type === "alumni" && selected?.type === "alumni" && selected.tier < state.plan.tier &&
      pending.fromPriceId === state.plan.priceId && pending.renewal === state.periodEnd && pending.renewal > Date.now() / 1000 &&
      !sub.pending_update && !sub.cancel_at_period_end && !sub.cancel_at) {
    await scheduleAlumniDowngrade({ stripe, sub, current: state.plan, selected, renewal: state.periodEnd, key, record, records, assertOwned });
    schedule = await stripe.subscriptionSchedules.retrieve(stripeId(sub.schedule));
  }
  if (!schedule.metadata?.bgsnlDowngradeOperation) return null;
  const next = planForPrice(schedule.metadata.bgsnlNextPrice, { selectable: true });
  const effectiveAt = Number(schedule.metadata.bgsnlChangeAt);
  if (!next || next.type !== "alumni" || !Number.isSafeInteger(effectiveAt) || effectiveAt <= 0) return null;
  if (state.hasBenefits && state.plan?.priceId === next.priceId && schedule.current_phase?.start_date >= effectiveAt &&
      !schedule.phases.some(phase => phase.start_date > schedule.current_phase.start_date)) {
    await assertOwned();
    await stripe.subscriptionSchedules.release(schedule.id, { preserve_cancel_date: true }, { idempotencyKey: `downgrade-release:${schedule.id}` });
    sub.schedule = null;
    return null;
  }
  return { priceId: next.priceId, tier: next.tier, effectiveAt: new Date(effectiveAt * 1000) };
}
