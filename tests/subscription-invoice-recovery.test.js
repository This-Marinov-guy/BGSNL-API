import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MEMBERSHIP_PLANS } from "../util/subscriptions/policy.js";
import { obsoleteRenewalInvoice, lateCanceledPayment, flagLateMembershipPayment, recoverCanceledMembershipInvoices } from "../services/subscriptions/invoice-recovery.js";

const fixture = () => {
  const sub = { id: "sub_one", customer: "cus_one", status: "canceled", ended_at: 106,
    current_period_start: 100, current_period_end: 200, cancellation_details: { reason: "payment_failed" },
    items: { data: [{ id: "si_one", quantity: 1, price: { id: MEMBERSHIP_PLANS[0].priceId } }] } };
  const invoice = { id: "in_one", subscription: sub.id, customer: sub.customer, status: "open", attempted: true,
    billing_reason: "subscription_cycle", amount_paid: 0, amount_due: 600, amount_remaining: 600, starting_balance: 0,
    lines: { data: [{ type: "subscription", subscription: sub.id, subscription_item: "si_one", price: sub.items.data[0].price,
      proration: false, amount: 600, period: { start: 100, end: 200 } }] } };
  return { sub, invoice };
};

test("only wholly unpaid failed central membership renewals qualify for voiding", () => {
  const { sub, invoice } = fixture();
  assert.equal(obsoleteRenewalInvoice(sub, invoice, "netherlands"), true);
  assert.equal(obsoleteRenewalInvoice(sub, invoice, "groningen"), false);
  for (const change of [{ status: "active" }, { ended_at: null }, { cancellation_details: { reason: "cancellation_requested" } }]) {
    assert.equal(obsoleteRenewalInvoice({ ...sub, ...change }, invoice, "netherlands"), false);
  }
  for (const change of [{ status: "paid" }, { status: "uncollectible" }, { amount_paid: 1 }, { amount_remaining: 500 },
    { starting_balance: -100 }, { customer: "cus_other" }, { subscription: "sub_other" }, { billing_reason: "manual" },
    { metadata: { bgsnlPreserveDebt: "1" } }, { payment_intent: { status: "processing" } }, { pre_payment_credit_notes_amount: 100 },
    { lines: { ...invoice.lines, has_more: true } }, { lines: { data: [] } }]) {
    assert.equal(obsoleteRenewalInvoice(sub, { ...invoice, ...change }, "netherlands"), false, JSON.stringify(change));
  }
  for (const change of [{ proration: true }, { type: "invoiceitem" }, { subscription_item: "si_other" },
    { price: { id: "price_ticket" } }, { period: { start: 1, end: 99 } }, { amount: -1 }]) {
    assert.equal(obsoleteRenewalInvoice(sub, { ...invoice, lines: { data: [{ ...invoice.lines.data[0], ...change }] } }, "netherlands"), false);
  }
});

test("voiding refreshes state, has a stable idempotency key, and never collects funds", async () => {
  const { sub, invoice } = fixture(); let voids = 0;
  const stripe = { invoices: {
    retrieve: async id => { assert.equal(id, invoice.id); return invoice; },
    voidInvoice: async (id, params, options) => { assert.equal(id, invoice.id); assert.deepEqual(params, {});
      assert.equal(options.idempotencyKey, "obsolete-membership-renewal:v1:in_one"); voids++; },
  } };
  assert.equal(await recoverCanceledMembershipInvoices(stripe, sub, [invoice], "netherlands"), true);
  assert.equal(voids, 1);
});

test("a payment during cleanup is flagged, never voided or silently renewed", async () => {
  const { sub, invoice } = fixture();
  const paid = { ...invoice, status: "paid", amount_paid: 600, amount_remaining: 0, status_transitions: { paid_at: 110 } };
  let reviews = 0;
  const stripe = { invoices: { retrieve: async () => paid, voidInvoice: () => assert.fail("Paid invoice must not be voided"),
    update: async (id, data) => { assert.equal(id, invoice.id); assert.equal(data.metadata.bgsnlLatePaymentReview, "pending"); reviews++; } } };
  await recoverCanceledMembershipInvoices(stripe, sub, [invoice], "netherlands");
  assert.equal(reviews, 1);
  assert.equal(lateCanceledPayment(sub, { ...paid, status_transitions: { paid_at: 105 } }, "netherlands"), false);
  assert.equal(lateCanceledPayment(sub, paid, "amsterdam"), false);
  assert.equal(await flagLateMembershipPayment(stripe, sub, { ...paid, metadata: { bgsnlLatePaymentReview: "replacement_term" } }, "netherlands"), false);
  assert.equal(reviews, 1);
});

test("a payment racing the actual void is recovered, while ambiguous errors retry", async () => {
  const { sub, invoice } = fixture(); let reads = 0, reviews = 0;
  const paid = { ...invoice, status: "paid", amount_paid: 600, status_transitions: { paid_at: 110 } };
  const stripe = { invoices: { retrieve: async () => ++reads === 1 ? invoice : paid,
    voidInvoice: async () => { throw new Error("invoice no longer open"); }, update: async () => { reviews++; } } };
  await recoverCanceledMembershipInvoices(stripe, sub, [invoice], "netherlands");
  assert.equal(reviews, 1);
  stripe.invoices.retrieve = async () => invoice;
  await assert.rejects(recoverCanceledMembershipInvoices(stripe, sub, [invoice], "netherlands"), /no longer open/);
});

test("signed webhook checks superseded subscriptions before attempting account reconciliation", async () => {
  const source = await readFile(new URL("../controllers/Webhooks/stripe-wh-controllers.js", import.meta.url), "utf8");
  assert.ok(source.indexOf("constructEvent(req.body") < source.indexOf("await recoverCanceledMembershipInvoices"));
  assert.ok(source.indexOf("await flagLateMembershipPayment") < source.lastIndexOf("await reconcileSubscription"));
  assert.match(source, /event\.type === "customer.subscription.deleted"/);
});
