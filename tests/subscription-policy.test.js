import assert from "node:assert/strict";
import test from "node:test";
import { MEMBERSHIP_PLANS, planForPrice, subscriptionState, accountEntitlements, invoiceSubscriptionId } from "../util/subscriptions/policy.js";
import { billingReturnUrl } from "../services/subscriptions/checkout.js";
import { extractUserFromRequest } from "../util/functions/security.js";

const now = Date.now();
const sub = (overrides = {}) => ({
  id: "sub_owner", customer: "cus_owner", status: "active",
  current_period_start: Math.floor(now / 1000) - 60,
  current_period_end: Math.floor(now / 1000) + 3600,
  latest_invoice: { id: "in_latest", status: "paid", amount_remaining: 0 },
  items: { data: [{ id: "si_one", quantity: 1, price: { id: MEMBERSHIP_PLANS[0].priceId } }] },
  ...overrides,
});

test("all six paid plans have a server-controlled type and period", () => {
  assert.equal(MEMBERSHIP_PLANS.length, 6);
  assert.deepEqual(MEMBERSHIP_PLANS.filter((p) => p.type === "member").map((p) => p.period), [6, 12]);
  assert.deepEqual(MEMBERSHIP_PLANS.filter((p) => p.type === "alumni").map((p) => p.tier), [1, 2, 3, 4]);
  assert.equal(planForPrice("price_forged", { selectable: true }), null);
});
test("paid active subscription grants benefits until Stripe's exact period end", () => {
  assert.equal(subscriptionState(sub(), [], now).hasBenefits, true);
  assert.equal(subscriptionState(sub(), [], now + 3601000).hasBenefits, false);
});
test("scheduled cancellation keeps benefits until the paid period ends", () => {
  const state = subscriptionState(sub({ cancel_at_period_end: true }), [], now);
  assert.equal(state.hasBenefits, true);
  assert.equal(state.ended, false);
});
for (const status of ["past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"]) {
  test(`${status} never grants benefits even when a previous invoice was paid`, () => {
    assert.equal(subscriptionState(sub({ status }), [], now).hasBenefits, false);
  });
}
test("unpaid older invoices lock an otherwise active subscription", () => {
  for (const status of ["open", "uncollectible"]) {
    const state = subscriptionState(sub(), [{ id: "in_old", subscription: "sub_owner", status, amount_remaining: 600, attempted: true }], now);
    assert.equal(state.lockReason, "payment_failed");
    assert.equal(state.reminderNeeded, true);
    assert.equal(state.hasBenefits, false);
  }
});
test("an invoice for another subscription cannot lock the current subscription", () => {
  assert.equal(subscriptionState(sub(), [{ subscription: "sub_other", status: "open", amount_remaining: 600 }], now).hasBenefits, true);
});
test("unpaid plan upgrades do not grant the new tier", () => {
  const state = subscriptionState(sub({ latest_invoice: { status: "open" }, pending_update: { expires_at: 123 } }), [], now);
  assert.equal(state.hasBenefits, false);
});
test("asynchronous payments still processing are pending, not failed, and do not send failure mail", () => {
  const pending = { id: "in_async", subscription: "sub_owner", status: "open", amount_remaining: 600, attempted: true, payment_intent: { status: "processing" } };
  const state = subscriptionState(sub({ latest_invoice: { status: "open" } }), [pending], now);
  assert.equal(state.hasBenefits, false);
  assert.equal(state.paymentFailed, false);
  assert.equal(state.reminderNeeded, false);
  assert.equal(state.lockReason, "payment_pending");
});
test("unsupported prices, multiple items, quantity changes and paused collection fail closed", () => {
  for (const changes of [
    { items: { data: [{ quantity: 1, price: { id: "price_unknown" } }] } },
    { items: { data: [...sub().items.data, ...sub().items.data] } },
    { items: { data: [{ ...sub().items.data[0], quantity: 2 }] } },
    { pause_collection: { behavior: "void" } },
  ]) assert.equal(subscriptionState(sub(changes), [], now).hasBenefits, false);
});
test("trial benefits require a current real trial, not just a trialing status", () => {
  assert.equal(subscriptionState(sub({ status: "trialing", trial_end: now / 1000 + 120 }), [], now).hasBenefits, true);
  assert.equal(subscriptionState(sub({ status: "trialing", trial_end: now / 1000 - 1 }), [], now).hasBenefits, false);
});
test("both old and new Stripe invoice subscription references are accepted", () => {
  assert.equal(invoiceSubscriptionId({ subscription: { id: "sub_old" } }), "sub_old");
  assert.equal(invoiceSubscriptionId({ parent: { subscription_details: { subscription: "sub_new" } } }), "sub_new");
});
test("stale snapshots, expired membership and locked staff cannot grant discounts", () => {
  const user = { status: "active", roles: ["member", "super_admin"], expireDate: new Date(now + 3600000),
    subscription: { id: "sub_owner", syncedAt: new Date(now), status: "active", hasBenefits: true } };
  assert.equal(accountEntitlements(user, now).memberDiscount, true);
  assert.equal(accountEntitlements({ ...user, status: "locked" }, now).memberDiscount, false);
  assert.equal(accountEntitlements(user, now + 300001).memberDiscount, false);
  assert.equal(accountEntitlements({ ...user, expireDate: new Date(now - 1) }, now).memberDiscount, false);
});
test("alumni identity does not depend on the legacy ID prefix", () => {
  const user = { _id: "member_old", roles: ["alumni"], tier: 2, status: "active", expireDate: new Date(now + 100000),
    subscription: { id: "sub_owner", syncedAt: new Date(now), status: "active", hasBenefits: true } };
  assert.equal(accountEntitlements(user, now).isAlumni, true);
  assert.equal(accountEntitlements(user, now).hasBenefits, true);
  assert.equal(accountEntitlements(user, now).memberDiscount, false);
  assert.equal(accountEntitlements({ ...user, tier: 0 }, now).hasBenefits, false);
});

test("frozen and suspended accounts cannot receive benefits from an otherwise paid subscription", () => {
  for (const status of ["frozen", "suspended"]) {
    const user = { status, roles: ["member", "super_admin"], expireDate: new Date(now + 3600000),
      subscription: { id: "sub_owner", syncedAt: new Date(now), status: "active", hasBenefits: true } };
    assert.equal(accountEntitlements(user, now).hasBenefits, false);
    assert.equal(accountEntitlements(user, now).memberDiscount, false);
  }
});
test("billing return URLs cannot redirect to external origins or embedded credentials", () => {
  assert.equal(billingReturnUrl("https://www.bulgariansociety.nl/user?x=y"), "https://www.bulgariansociety.nl/user#settings");
  for (const url of ["https://evil.example/user", "https://bulgariansociety.nl.evil.example", "https://evil@bulgariansociety.nl", "javascript:alert(1)"]) {
    assert.throws(() => billingReturnUrl(url));
  }
});
test("unsigned client JWT payloads and body IDs are not treated as identity", () => {
  assert.deepEqual(extractUserFromRequest({ headers: { authorization: "Bearer forged.jwt.signature" }, body: { userId: "victim" } }), {});
  assert.deepEqual(extractUserFromRequest({ user: { userId: "verified" } }), { userId: "verified" });
});

test("voided pending updates restore only the original, still-paid plan and period", () => {
  const subscription = sub({ latest_invoice: { status: "void" } });
  const invoice = { id: "in_original", subscription: subscription.id, status: "paid", lines: { data: [{
    subscription_item: "si_one", price: subscription.items.data[0].price,
    amount: 600, period: { start: subscription.current_period_start, end: subscription.current_period_end },
  }] } };
  assert.equal(subscriptionState(subscription, [], now, [invoice]).hasBenefits, true);
  for (const line of [
    { ...invoice.lines.data[0], subscription_item: "si_someone_else" },
    { ...invoice.lines.data[0], price: { id: MEMBERSHIP_PLANS[1].priceId } },
    { ...invoice.lines.data[0], amount: -600 },
    { ...invoice.lines.data[0], period: { start: 1, end: subscription.current_period_start } },
  ]) assert.equal(subscriptionState(subscription, [], now, [{ ...invoice, lines: { data: [line] } }]).hasBenefits, false);
  assert.equal(subscriptionState(subscription, [], now, [{ ...invoice, subscription: "sub_other" }]).hasBenefits, false);
  assert.equal(subscriptionState({ ...subscription, pending_update: {} }, [], now, [invoice]).hasBenefits, false);
  assert.equal(subscriptionState({ ...subscription, status: "past_due" }, [], now, [invoice]).hasBenefits, false);
});
test("processing one invoice cannot conceal another unpaid invoice needing attention", () => {
  const invoices = [
    { id: "in_processing", subscription: "sub_owner", status: "open", amount_remaining: 600, attempted: true, payment_intent: { status: "processing" } },
    { id: "in_failed", subscription: "sub_owner", status: "open", amount_remaining: 600, attempted: true, payment_intent: { status: "requires_payment_method" } },
  ];
  const state = subscriptionState(sub(), invoices, now);
  assert.equal(state.hasBenefits, false);
  assert.equal(state.reminderNeeded, true);
  assert.equal(state.failureInvoiceId, "in_failed");
});


test("VIP ignores membership expiry but keeps Stripe verification and account restrictions", () => {
  const user = { status: "active", roles: ["member", "vip"], expireDate: new Date(0) };
  assert.equal(accountEntitlements(user, now).nonExpiring, true);
  assert.equal(accountEntitlements(user, now).hasBenefits, true);
  const subscription = { id: "sub_owner", syncedAt: new Date(now), status: "active", hasBenefits: true };
  assert.equal(accountEntitlements({ ...user, subscription }, now).hasBenefits, true);
  assert.equal(accountEntitlements({ ...user, subscription }, now + 300001).hasBenefits, false);
  assert.equal(accountEntitlements({ ...user, subscription: { ...subscription, hasBenefits: false, lockReason: "payment_failed" } }, now).hasBenefits, false);
  for (const status of ["locked", "payment_awaiting", "frozen", "suspended", "membership-migrated"]) {
    assert.equal(accountEntitlements({ ...user, status }, now).hasBenefits, false);
  }
  assert.equal(accountEntitlements({ ...user, roles: ["member"] }, now).hasBenefits, false);
  assert.equal(accountEntitlements({ ...user, roles: ["alumni", "vip"], tier: 0 }, now).hasBenefits, false);
});
