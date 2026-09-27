import test from "node:test";
import assert from "node:assert/strict";
import { previewMembershipChange } from "../services/subscriptions/checkout.js";
import { MEMBERSHIP_PLANS } from "../util/subscriptions/policy.js";

function harness(from = MEMBERSHIP_PLANS[0]) {
  const user = { id: "user_test", status: "active", expireDate: new Date("2099-01-01"),
    subscription: { id: "sub_test", customerId: "cus_test", status: "active", hasBenefits: true, syncedAt: new Date() } };
  const sub = { id: "sub_test", customer: "cus_test", status: "active", items: { data: [{ id: "si_test", price: from.priceId, quantity: 1 }] } };
  const calls = [];
  const stripe = {
    prices: { retrieve: async id => { const plan = MEMBERSHIP_PLANS.find(p => p.priceId === id);
      return { active: true, unit_amount: 2000, currency: "eur", product: "prod_test", recurring: { interval: "month", interval_count: plan.period } }; } },
    invoices: { retrieveUpcoming: async params => { calls.push(params); return { amount_due: 725, currency: "eur", customer: "cus_test" }; } },
  };
  const dependencies = { reconcile: async () => ({ user, sub, stripe, region: "netherlands" }) };
  return { user, sub, stripe, calls, dependencies, preview: plan => previewMembershipChange(user, { priceId: plan.priceId, dependencies }) };
}

test("immediate changes preview the owned item with invoiced prorations, returning Stripe's amount including credits", async () => {
  for (const [from, to] of [[0, 2], [2, 0], [2, 5]]) {
    const h = harness(MEMBERSHIP_PLANS[from]);
    const quote = await h.preview(MEMBERSHIP_PLANS[to]);
    assert.deepEqual(quote, { priceId: MEMBERSHIP_PLANS[to].priceId, amountDue: 725, currency: "eur", chargeNow: true });
    assert.deepEqual(h.calls[0], { customer: "cus_test", subscription: "sub_test", subscription_items: [
      { id: "si_test", price: MEMBERSHIP_PLANS[to].priceId, quantity: 1 },
    ], subscription_proration_behavior: "always_invoice" });
  }
});

test("deferred changes return zero today without previewing a renewal charge as an immediate payment", async () => {
  for (const [from, to] of [[0, 1], [1, 0], [5, 2]]) {
    const h = harness(MEMBERSHIP_PLANS[from]);
    const quote = await h.preview(MEMBERSHIP_PLANS[to]);
    assert.equal(quote.amountDue, 0);
    assert.equal(quote.chargeNow, false);
    assert.equal(h.calls.length, 0);
  }
});

test("trial conversions preview ending the trial, matching the payment confirmation flow", async () => {
  const h = harness(); h.sub.status = "trialing";
  await h.preview(MEMBERSHIP_PLANS[2]);
  assert.equal(h.calls[0].subscription_trial_end, "now");
});

test("new and restarted subscriptions reuse customer balance in the preview without creating a customer", async () => {
  for (const subscription of [{ customerId: "cus_test" }, { id: "sub_old", customerId: "cus_test", status: "canceled" }, undefined]) {
    const h = harness(); h.user.subscription = subscription;
    await h.preview(MEMBERSHIP_PLANS[0]);
    assert.equal(h.calls[0].customer, subscription?.customerId);
    assert.equal(h.calls[0].subscription, undefined);
    assert.deepEqual(h.calls[0].subscription_items, [{ price: MEMBERSHIP_PLANS[0].priceId, quantity: 1 }]);
  }
});

test("unsafe account states and customer mismatches cannot expose a billing preview", async () => {
  for (const mutate of [
    h => { h.user.status = "frozen"; }, h => { h.user.subscription.hasBenefits = false; },
    h => { h.sub.customer = "cus_other"; }, h => { h.sub.id = "sub_other"; },
    h => { h.sub.schedule = "sched_existing"; }, h => { h.sub.pending_update = {}; },
    h => { h.sub.cancel_at_period_end = true; }, h => { h.sub.items.data[0].quantity = 2; },
  ]) {
    const h = harness(); mutate(h);
    await assert.rejects(h.preview(MEMBERSHIP_PLANS[2]));
    assert.equal(h.calls.length, 0);
  }
});

test("zero due is valid; invalid or unavailable amounts never fall back to the full catalog price", async () => {
  const h = harness();
  h.stripe.invoices.retrieveUpcoming = async () => ({ amount_due: 0, currency: "eur", customer: "cus_test" });
  assert.equal((await h.preview(MEMBERSHIP_PLANS[2])).amountDue, 0);
  for (const override of [{ amount_due: -1 }, { amount_due: null }, { currency: "usd" }, { customer: "cus_other" }]) {
    h.stripe.invoices.retrieveUpcoming = async () => ({ amount_due: 725, currency: "eur", customer: "cus_test", ...override });
    await assert.rejects(h.preview(MEMBERSHIP_PLANS[2]), error => error.statusCode === 503);
  }
  h.stripe.invoices.retrieveUpcoming = async () => { throw new Error("Stripe unavailable"); };
  await assert.rejects(h.preview(MEMBERSHIP_PLANS[2]), /Stripe unavailable/);
});
