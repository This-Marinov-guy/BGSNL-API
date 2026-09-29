import test from "node:test";
import assert from "node:assert/strict";
import { replacementTerm, repairLateMembershipPayment } from "../scripts/repair-late-membership-payment.mjs";

function fixture() {
  const start = Math.floor(Date.now() / 1000) - 86400;
  const account = { _id: "member_one", roles: ["member"], status: "locked", subscription: { id: "sub_old", customerId: "cus_one" } };
  const old = { id: "sub_old", status: "canceled", customer: "cus_one", ended_at: start - 100,
    items: { data: [{ quantity: 1, price: { id: "price_year", unit_amount: 1000, currency: "eur", active: true,
      recurring: { interval: "year", interval_count: 1 } } }] } };
  const charge = { paid: true, refunded: false, amount_refunded: 0, disputed: false, customer: "cus_one", invoice: "in_paid", amount: 1000, currency: "eur" };
  const source = { id: "in_paid", number: "BGSNL-1", subscription: old.id, customer: "cus_one", status: "paid", amount_paid: 1000,
    amount_remaining: 0, currency: "eur", billing_reason: "subscription_cycle", status_transitions: { paid_at: start }, charge, metadata: {} };
  let replacement, confirmation, writes = 0, creates = 0;
  const stripe = {
    subscriptions: {
      list: async function* () { yield old; if (replacement) yield replacement; },
      retrieve: async id => id === old.id ? old : { ...replacement, latest_invoice: confirmation },
      create: async (data, options) => {
        assert.equal(data.collection_method, "send_invoice"); assert.equal(data.proration_behavior, "none");
        assert.equal(data.billing_cycle_anchor, data.cancel_at); assert.equal(data.backdate_start_date, start);
        assert.ok(options.idempotencyKey); creates++;
        replacement = { ...data, id: "sub_new", status: "active", current_period_start: start + 100, current_period_end: data.cancel_at,
          items: { data: [{ price: { id: data.items[0].price } }] } }; return replacement;
      },
    },
    invoices: {
      retrieve: async id => id === source.id ? source : confirmation,
      list: async function* () { if (confirmation) yield confirmation; },
      create: async data => { assert.equal(data.auto_advance, false); assert.equal(data.subscription, "sub_new");
        confirmation = { ...data, id: "in_zero", status: "draft", amount_due: 0, amount_paid: 0, total: 0, starting_balance: 0, lines: { data: [] } }; return confirmation; },
      finalizeInvoice: async (_id, data) => { assert.equal(data.auto_advance, false); confirmation.status = "paid"; return confirmation; },
      update: async (id, data) => { assert.equal(id, source.id); Object.assign(source.metadata, data.metadata); },
    },
    invoiceItems: { create: async data => { assert.equal(data.amount, 0); assert.equal(data.invoice, "in_zero"); confirmation.lines.data.push(data); } },
  };
  const collection = { findOne: async () => account, updateOne: async (filter, update) => {
    assert.equal(filter["subscription.id"], account.subscription.id); writes++;
    account.subscription.id = update.$set["subscription.id"]; account.status = update.$set.status;
    assert.equal(update.$set["subscription.hasBenefits"], true);
    assert.equal(update.$set["subscription.cancelAt"].getTime(), replacement.cancel_at * 1000);
    return { matchedCount: 1 };
  } };
  return { account, old, source, charge, stripe, collection,
    run: apply => repairLateMembershipPayment({ stripe, collection, account, invoiceId: source.id, apply }),
    counts: () => ({ writes, creates }) };
}

test("repair dry-run validates without creating billing objects or writing account state", async () => {
  const h = fixture(); const result = await h.run(false);
  assert.equal(result.additionalCharge, 0); assert.equal(result.automaticRenewal, false);
  assert.deepEqual(h.counts(), { writes: 0, creates: 0 });
});

test("repair gives a paid zero-due non-renewing term and replays without creating a second subscription", async () => {
  const h = fixture();
  const result = await h.run(true);
  assert.equal(result.replacementSubscription, "sub_new"); assert.equal(result.additionalCharge, 0);
  assert.equal(h.source.amount_paid, 1000); assert.equal(h.source.metadata.bgsnlLatePaymentReview, "replacement_term");
  await h.run(true);
  assert.deepEqual(h.counts(), { writes: 2, creates: 1 });
});

test("refunded, disputed, partially credited or mismatched payments never qualify", () => {
  const h = fixture();
  for (const change of [{ refunded: true }, { amount_refunded: 1 }, { disputed: true }, { customer: "cus_other" }, { amount: 500 }]) {
    assert.throws(() => replacementTerm(h.account, h.old, h.source, { ...h.charge, ...change }), /manual review/);
  }
  assert.throws(() => replacementTerm({ ...h.account, status: "suspended" }, h.old, h.source, h.charge), /manual review/);
  assert.throws(() => replacementTerm(h.account, h.old, { ...h.source, post_payment_credit_notes_amount: 1000 }, h.charge), /manual review/);
});

test("another running subscription prevents a replacement", async () => {
  const h = fixture(); h.stripe.subscriptions.list = async function* () { yield h.old; yield { id: "sub_other", status: "active" }; };
  await assert.rejects(h.run(true), /Another running subscription/);
  assert.deepEqual(h.counts(), { writes: 0, creates: 0 });
});

test("unexpected chargeable invoice never finalizes and never unlocks the account", async () => {
  const h = fixture(); const create = h.stripe.invoices.create;
  h.stripe.invoices.create = async data => { const invoice = await create(data); invoice.amount_due = 100; return invoice; };
  h.stripe.invoices.finalizeInvoice = () => assert.fail("Must not finalize");
  await assert.rejects(h.run(true), /Refusing to finalize/);
  assert.equal(h.counts().writes, 0);
});
