import assert from "node:assert/strict";
import test from "node:test";
import { memberRevenueAllocation } from "../util/config/member-revenue.js";
import { MEMBERSHIP_PLANS } from "../util/subscriptions/policy.js";
import { memberRevenueMetadata } from "../services/subscriptions/stripe-revenue-state.js";
import { pendingMemberTransfer } from "../services/subscriptions/pending-payments.js";
import { backfillPendingStripeFunds } from "../scripts/backfill-pending-stripe-funds.js";
import { listPendingPayments, normalizePaymentPage } from "../services/monitoring/payments.js";

const allocation = memberRevenueAllocation(MEMBERSHIP_PLANS.find(plan => plan.type === "member"), "amsterdam",
  { MEMBER_REVENUE_SHARING_ENABLED: "true" });
const sub = { id: "sub_test", customer: "cus_test", livemode: true, created: 1,
  metadata: memberRevenueMetadata(allocation, "cus_test", "checkout:test") };
const invoice = (id, operation) => ({ id, subscription: sub.id, status: "paid", created: 1767225600,
  metadata: { bgsnlPendingRevenueOperation: JSON.stringify(operation) } });
const operation = (id, balanceDeferred = false) => ({ id, kind: "transfer", amount: 760, before: 0,
  ...(balanceDeferred ? { balanceDeferred: true } : {}) });

test("only a deferred transfer can become a waiting-funds payment", () => {
  const row = pendingMemberTransfer({ _id: "in_test", subscriptionId: sub.id, accountId: allocation.accountId,
    region: "amsterdam", livemode: true, paidAt: new Date("2026-01-01"),
    operation: operation("op_test", true) });
  assert.equal(row.type, "member_revenue_transfer");
  assert.equal(row.reason, "waiting_stripe_funds");
  assert.equal(row.amountCents, 760);
  assert.throws(() => pendingMemberTransfer({ ...row, operation: operation("op_test") }), /Invalid deferred/);
});

test("backfill imports confirmed legacy and marked deferrals, skips settled transfers, and is idempotent", async () => {
  const invoices = [invoice("in_legacy", operation("op_legacy")), invoice("in_marked", operation("op_marked", true)),
    invoice("in_settled", operation("op_settled", true))];
  const transfers = new Map([["in_settled", [{ id: "tr_settled", amount: 760, amount_reversed: 0,
    metadata: { bgsnlRevenueOperation: "op_settled" } }]]]);
  const stripe = { subscriptions: { list: async function* () { yield sub; } },
    invoices: { list: async function* () { yield* invoices; }, retrieve: async id => invoices.find(item => item.id === id) },
    transfers: { list: ({ transfer_group }) => (async function* () { yield* transfers.get(transfer_group.slice("bgsnl-member:".length)) || []; })() } };
  const records = new Map();
  const collection = { createIndex: async () => {}, updateOne: async ({ _id }, update) => {
    const prior = records.get(_id);
    records.set(_id, { ...prior, ...update.$setOnInsert, ...update.$set });
    return { upsertedCount: prior ? 0 : 1, matchedCount: prior ? 1 : 0 };
  } };
  const options = { stripe, collection, legacyConfirmed: new Set(["in_legacy"]) };
  const dryRun = await backfillPendingStripeFunds(options);
  assert.deepEqual(dryRun.rows.map(row => row.invoiceId), ["in_legacy", "in_marked"]);
  assert.equal(records.size, 0);
  const first = await backfillPendingStripeFunds({ ...options, apply: true, expectedCount: 2 });
  assert.equal(first.inserted, 2);
  assert.equal(records.get("in_legacy").reason, "waiting_stripe_funds");
  const second = await backfillPendingStripeFunds({ ...options, apply: true, expectedCount: 2 });
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 2);
  transfers.set("in_marked", [{ id: "tr_marked", amount: 760, amount_reversed: 0,
    metadata: { bgsnlRevenueOperation: "op_marked" } }]);
  const changed = await backfillPendingStripeFunds(options);
  assert.deepEqual(changed.rows.map(row => row.invoiceId), ["in_legacy"]);
});

test("backfill removes its row if Stripe settles during the write", async () => {
  const pending = invoice("in_race", operation("op_race", true));
  let retrievals = 0;
  const stripe = { subscriptions: { list: async function* () { yield sub; } },
    invoices: { list: async function* () { yield pending; }, retrieve: async () => ++retrievals === 1 ? pending : { ...pending, metadata: {} } },
    transfers: { list: () => (async function* () {})() } };
  const records = new Map();
  const collection = { createIndex: async () => {}, updateOne: async ({ _id }, update) => {
    records.set(_id, { ...update.$set, ...update.$setOnInsert });
    return { upsertedCount: 1, matchedCount: 0 };
  }, deleteOne: async ({ _id, operationId }) => {
    if (records.get(_id)?.operationId === operationId) records.delete(_id);
  } };
  const result = await backfillPendingStripeFunds({ stripe, collection, apply: true, expectedCount: 1 });
  assert.equal(result.resolvedDuringApply, 1);
  assert.equal(records.size, 0);
});

test("monitoring lists only live waiting transfers and validates pages", async () => {
  assert.equal(normalizePaymentPage(undefined), 1);
  assert.equal(normalizePaymentPage("2"), 2);
  assert.equal(normalizePaymentPage("0"), null);
  assert.equal(normalizePaymentPage("101"), null);
  let filter;
  const model = { countDocuments: async query => { filter = query; return 1; },
    find: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [{ _id: "in_test", subscriptionId: sub.id,
      accountId: allocation.accountId, region: "amsterdam", amountCents: 760, currency: "eur",
      type: "member_revenue_transfer", reason: "waiting_stripe_funds" }] }) }) }) }) };
  const result = await listPendingPayments({ model, livemode: true });
  assert.deepEqual(filter, { type: "member_revenue_transfer", reason: "waiting_stripe_funds", livemode: true });
  assert.equal(result.items[0].invoiceId, "in_test");
  assert.equal(result.total, 1);
});
