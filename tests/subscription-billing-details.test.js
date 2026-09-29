import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { readBillingDetails } from "../services/subscriptions/billing-details.js";
import { MEMBERSHIP_PLANS } from "../util/subscriptions/policy.js";

const user = { id: "account", status: "locked", subscription: { id: "sub_owner", customerId: "cus_owner" } };
function fixture(reason = "payment_failed", code = "insufficient_funds") {
  const invoice = { id: "in_unpaid", subscription: "sub_owner", customer: "cus_owner", amount_remaining: 1200, currency: "eur",
    payment_intent: { client_secret: "secret-never-return", last_payment_error: { decline_code: code, message: "Raw private message" } } };
  const result = { sub: { id: "sub_owner", customer: "cus_owner", latest_invoice: { id: "in_new_paid" } },
    state: { lockReason: reason, failureInvoiceId: invoice.id }, invoices: [invoice] };
  return { invoice, result, dependencies: {
    resolveRegion: async (account) => { assert.equal(account, user); return "groningen"; },
    stripeForRegion: (region) => { assert.equal(region, "groningen"); return {}; },
    readSubscription: async (stripe, id) => { assert.equal(id, "sub_owner"); return result; },
  } };
}

test("missing membership is distinguished without calling Stripe", async () => {
  const notice = await readBillingDetails({ status: "locked" }, { resolveRegion: () => assert.fail("No Stripe request") });
  assert.equal(notice.reason, "no_membership");
  assert.match(notice.description, /linked to this account/);
});

test("diagnostics identify the failed older invoice, not a newer paid invoice", async () => {
  const h = fixture();
  const notice = await readBillingDetails(user, h.dependencies);
  assert.equal(notice.reason, "payment_failed");
  assert.match(notice.description, /insufficient funds/);
  assert.equal(notice.amountDue, 1200);
  assert.equal(notice.currency, "eur");
  assert.doesNotMatch(JSON.stringify(notice), /secret-never-return|Raw private|payment_intent|cus_owner/);
});

for (const code of ["fraudulent", "stolen_card", "unknown_code"]) test(`sensitive/unknown decline ${code} uses safe generic wording`, async () => {
  const h = fixture("payment_failed", code);
  const notice = await readBillingDetails(user, h.dependencies);
  assert.match(notice.description, /membership payment is still unpaid/);
  assert.equal(JSON.stringify(notice).includes(code), false);
});

for (const reason of ["subscription_ended", "subscription_paused", "unsupported_plan", "payment_pending"]) test(`explains ${reason} without claiming a failed payment`, async () => {
  const h = fixture(reason);
  const notice = await readBillingDetails(user, h.dependencies);
  assert.equal(notice.reason, reason);
  assert.doesNotMatch(notice.title, /unsuccessful/);
  assert.equal(notice.amountDue, undefined);
});

test("fresh paid state does not grant benefits or suggest another payment", async () => {
  const h = fixture(); h.result.state = { hasBenefits: true };
  const before = structuredClone(user);
  const notice = await readBillingDetails(user, h.dependencies);
  assert.equal(notice.reason, "account_sync_pending");
  assert.match(notice.description, /Do not start another payment/);
  assert.deepEqual(user, before);
});

test("late payment on a canceled subscription offers credit/refund review instead of another charge", async () => {
  const h = fixture();
  h.dependencies.resolveRegion = async () => "netherlands";
  h.dependencies.stripeForRegion = () => ({});
  Object.assign(h.result.sub, { status: "canceled", ended_at: 100, items: { data: [{ price: { id: MEMBERSHIP_PLANS[0].priceId } }] },
    latest_invoice: { id: "in_paid", subscription: "sub_owner", customer: "cus_owner", status: "paid", amount_paid: 1000, status_transitions: { paid_at: 110 } } });
  const notice = await readBillingDetails(user, h.dependencies);
  assert.equal(notice.reason, "late_payment_review");
  assert.match(notice.description, /credit.*refund/);
  assert.match(notice.description, /do not pay again/);
  assert.doesNotMatch(JSON.stringify(notice), /Stripe/);
});

test("ownership is verified before exposing invoice details", async () => {
  const h = fixture(); h.result.sub.customer = "cus_other";
  await assert.rejects(readBillingDetails(user, h.dependencies), (error) => error.statusCode === 503);
  h.result.sub.customer = "cus_owner"; h.invoice.customer = "cus_other";
  const notice = await readBillingDetails(user, h.dependencies);
  assert.equal(notice.amountDue, undefined);
  assert.doesNotMatch(notice.description, /insufficient funds/);
});

test("Stripe outages are errors, never a missing membership or failed payment", async () => {
  const h = fixture(); h.dependencies.readSubscription = async () => { throw new Error("Stripe unavailable"); };
  await assert.rejects(readBillingDetails(user, h.dependencies), /Stripe unavailable/);
});

test("administrative restrictions do not trigger billing requests", async () => {
  for (const status of ["frozen", "suspended"]) {
    const notice = await readBillingDetails({ ...user, status }, { resolveRegion: () => assert.fail("No Stripe request") });
    assert.equal(notice.reason, "account_restricted");
    assert.match(notice.description, /will not remove/);
  }
});

test("billing details route requires authentication and uses the server account", async () => {
  const routes = await readFile(new URL("../routes/payments-routes.js", import.meta.url), "utf8");
  const controller = await readFile(new URL("../controllers/subscriptions-controller.js", import.meta.url), "utf8");
  assert.match(routes, /get\("\/subscription\/billing-details", authMiddleware, getBillingDetails\)/);
  assert.match(controller, /readBillingDetails\(req\.account\)/);
  await assert.rejects(readBillingDetails(null), (error) => error.statusCode === 401);
});
