import { memberRevenueMetadata, createRevenueSnapshot } from "../services/subscriptions/stripe-revenue-state.js";
import assert from "node:assert/strict";
import test from "node:test";
import { MEMBER_REVENUE_ACCOUNTS, MEMBER_REVENUE_PLATFORM, memberRevenueAllocation } from "../util/config/member-revenue.js";
import { MEMBERSHIP_PLANS } from "../util/subscriptions/policy.js";
import { captureMemberRevenueEvent, recordMemberRevenueInvoice, registerMemberRevenueSubscription, revenueTarget, settleMemberRevenueRegion, processMemberRevenueSharing, migratedInvoiceBoundary } from "../services/subscriptions/revenue-sharing.js";
import { allocateMemberFees, parseMemberFeeReport, downloadMemberFeeReport, processMemberRevenueFees, processMemberRevenueMaintenance, resolveMemberFeeReferences } from "../services/subscriptions/revenue-fees.js";

const member = MEMBERSHIP_PLANS.find(p => p.type === "member");
const alumni = MEMBERSHIP_PLANS.find(p => p.type === "alumni");
const accountId = MEMBER_REVENUE_ACCOUNTS.amsterdam;
const allocation = memberRevenueAllocation(member, "amsterdam", { MEMBER_REVENUE_SHARING_ENABLED: "true" });
const migratedAllocation = { ...allocation, version: 2, enrolledAt: 1767400000, effectivePeriodStart: 1768000000 };
const get = (o, key) => key.split('.').reduce((v, k) => v?.[k], o);
function matches(o, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === "$or") return value.some(q => matches(o, q));
    const actual = get(o, key);
    if (value instanceof RegExp) return value.test(actual);
    if (value && typeof value === "object" && !(value instanceof Date)) return Object.entries(value).every(([op, v]) => op === "$exists" ? (actual !== undefined) === v : op === "$lt" ? actual < v : actual === v);
    return actual === value;
  });
}
function memory(initial = []) {
  const docs = new Map(initial.map(d => [d._id, structuredClone(d)]));
  const query = (items, one = false) => {
    const q = { sort: (keys) => { items.sort((a, b) => { for (const [key, direction] of Object.entries(keys)) { if (get(a, key) < get(b, key)) return -direction; if (get(a, key) > get(b, key)) return direction; } return 0; }); return q; },
      limit: n => { items = items.slice(0, n); return q; }, lean: () => q,
      then: (resolve, reject) => Promise.resolve(structuredClone(one ? items[0] : items)).then(resolve, reject) };
    return q;
  };
  return { docs, findById: async id => structuredClone(docs.get(id)),
    find: filter => query([...docs.values()].filter(d => matches(d, filter))),
    findOne: filter => query([...docs.values()].filter(d => matches(d, filter)), true),
    updateOne: async (filter, update, options = {}) => {
      let doc = [...docs.values()].find(d => matches(d, filter));
      const created = !doc;
      if (!doc && !options.upsert) return { matchedCount: 0 };
      if (!doc) { doc = { _id: filter._id }; docs.set(doc._id, doc); }
      const set = { ...(created ? update.$setOnInsert : {}), ...update.$set };
      for (const [key, value] of Object.entries(set)) {
        const parts = key.split('.'); const last = parts.pop(); let obj = doc;
        for (const part of parts) obj = obj[part] ||= {};
        obj[last] = structuredClone(value);
      }
      for (const key of Object.keys(update.$unset || {})) delete doc[key];
      return { matchedCount: 1 };
    } };
}
const withLease = async (_key, work) => work({ record: {}, assertOwned: async () => {} });
const sub = { id: "sub_one", customer: "cus_one", livemode: true, created: 1767225600,
  metadata: { bgsnlCheckoutKey: "checkout:one", ...memberRevenueMetadata(allocation, "cus_one", "op_one") } };
const recordsFor = () => memory([{ _id: "checkout:one", data: { operationId: "op_one", customerId: "cus_one", stripeRegion: "netherlands", priceId: member.priceId, revenueAllocation: allocation } }]);
const shareFor = (id = "in_one", values = {}) => ({ _id: id, invoiceId: id, livemode: true, accountId, region: "amsterdam", subscriptionId: sub.id,
  chargeId: `ch_${id}`, chargeAmount: 1000, balanceTransactionId: `txn_${id}`, gross: 1000, refunded: 0, processingFee: 40, extraFees: {}, creditedByInvoice: {}, paidAt: new Date("2026-01-03"), ...values });
const invoiceFor = (id = "in_one", values = {}) => ({ id, subscription: sub.id, customer: sub.customer, livemode: true, status: "paid", currency: "eur", amount_paid: 1000, created: 1767398400,
  lines: { data: [{ amount: 1000, price: { id: member.priceId }, subscription: sub.id }] },
  charge: { id: `ch_${id}`, customer: sub.customer, invoice: id, paid: true, captured: true, livemode: true, amount: 1000, amount_refunded: 0, currency: "eur", balance_transaction: { id: `txn_${id}`, amount: 1000, fee: 40, currency: "eur" } }, ...values });
function stripeFor(invoices = []) {
  const transfers = []; const calls = []; let failTransfer = false; let failReversal = false;
  const stripe = {
    accounts: { retrieve: async id => ({ id: id || MEMBER_REVENUE_PLATFORM, capabilities: { transfers: "active" }, payouts_enabled: true }) },
    balance: { retrieve: async () => ({ livemode: true }) },
    subscriptions: { retrieve: async () => structuredClone(sub), list: async function* () { yield structuredClone(sub); } },
    invoices: { update: async (id, body) => { const invoice = invoices.find(item => item.id === id); invoice.metadata = { ...invoice.metadata, ...body.metadata }; return structuredClone(invoice); }, retrieve: async id => { const value = invoices.find(i => i.id === id); assert.ok(value, id); return structuredClone(value); },
      list: () => (async function* () { yield* [...invoices].reverse(); })() },
    transfers: {
      list: options => (async function* () { yield* transfers.filter(t => t.transfer_group === options.transfer_group && t.destination === options.destination); })(),
      create: async (body, options) => { calls.push({ kind: "transfer", body, options }); const t = { id: `tr_${transfers.length}`, ...structuredClone(body), amount_reversed: 0, reversals: [] }; transfers.push(t); if (failTransfer) { failTransfer = false; throw new Error("ambiguous transfer timeout"); } return t; },
      listReversals: id => (async function* () { yield* transfers.find(t => t.id === id).reversals; })(),
      createReversal: async (id, body) => { if (failReversal) throw new Error("insufficient regional balance"); calls.push({ kind: "reversal", body }); const t = transfers.find(t => t.id === id); t.amount_reversed += body.amount; const r = { id: `trr_${t.reversals.length}`, ...structuredClone(body) }; t.reversals.push(r); return r; },
    },
  };
  return { stripe, transfers, calls, failNextTransfer: () => { failTransfer = true; }, failReversals: () => { failReversal = true; } };
}

test("enrolment is opt-in, Member-only and limited to server-known regions", () => {
  assert.equal(memberRevenueAllocation(member, "amsterdam", {}), null);
  assert.equal(memberRevenueAllocation(alumni, "amsterdam", { MEMBER_REVENUE_SHARING_ENABLED: "true" }), null);
  assert.equal(memberRevenueAllocation(member, "invented", { MEMBER_REVENUE_SHARING_ENABLED: "true" }), null);
  assert.equal(allocation.accountId, accountId);
});
test("central retains 20% after actual fees, including partial/full refunds and later fees", () => {
  assert.equal(revenueTarget(shareFor()), 760);
  assert.equal(revenueTarget(shareFor("x", { refunded: 500 })), 360);
  assert.equal(revenueTarget(shareFor("x", { refunded: 1000 })), -40);
  assert.equal(revenueTarget(shareFor("x", { extraFees: { "2026-01": 25 } })), 735);
  assert.throws(() => revenueTarget(shareFor("x", { gross: NaN })), /Invalid/);
});
test("allocation survives reservation reuse, while old and forged subscriptions cannot enrol", async () => {
  const records = recordsFor();
  assert.equal((await registerMemberRevenueSubscription(sub, { records })).accountId, accountId);
  records.docs.get("checkout:one").data = {};
  assert.equal((await registerMemberRevenueSubscription(sub, { records })).accountId, accountId);
  assert.equal(await registerMemberRevenueSubscription({ ...sub, id: "sub_old", metadata: {} }, { records }), null);
  for (const change of [{ customer: "cus_other" }, { livemode: false }, { metadata: { ...sub.metadata, bgsnlRevenueOperation: "forged" } }]) {
    await assert.rejects(registerMemberRevenueSubscription({ ...sub, id: "sub_forged", ...change }), /ownership mismatch/);
  }
});
test("first invoice and renewals are idempotent; Alumni invoices earn no regional share", async () => {
  const invoices = [invoiceFor(), invoiceFor("in_renewal"), invoiceFor("in_alumni", { lines: { data: [{ amount: 1000, price: alumni.priceId }] } })];
  const { stripe } = stripeFor(invoices); const records = recordsFor(); const shares = memory();
  for (const invoice of [...invoices, ...invoices]) await recordMemberRevenueInvoice(invoice.id, { stripe, records, shares });
  assert.deepEqual([...shares.docs.keys()], ["in_one", "in_renewal"]);
  assert.equal(shares.docs.get("in_one").processingFee, 40);
});
test("migrated subscriptions share only invoices created after enrolment for a full eligible service period", async () => {
  const old = invoiceFor("in_old", { created: 1769000000, lines: { data: [
    { amount: 1000, price: { id: member.priceId }, period: { start: 1767000000, end: migratedAllocation.effectivePeriodStart } },
  ] } });
  const prepaid = invoiceFor("in_prepaid", { created: migratedAllocation.enrolledAt - 1, lines: { data: [
    { amount: 1000, price: { id: member.priceId }, period: { start: migratedAllocation.effectivePeriodStart, end: 1770000000 } },
  ] } });
  const renewal = invoiceFor("in_renewal", { created: 1769000000, lines: { data: [
    { amount: 1000, price: { id: member.priceId }, period: { start: migratedAllocation.effectivePeriodStart, end: 1770000000 } },
  ] } });
  const h = stripeFor([old, prepaid, renewal]);
  h.stripe.subscriptions.retrieve = async () => ({ ...sub, metadata: memberRevenueMetadata(migratedAllocation, sub.customer, "migration:one") });
  const shares = memory();
  assert.equal(await recordMemberRevenueInvoice(old.id, { stripe: h.stripe, shares }), null);
  assert.equal(await recordMemberRevenueInvoice(prepaid.id, { stripe: h.stripe, shares }), null);
  await recordMemberRevenueInvoice(renewal.id, { stripe: h.stripe, shares });
  assert.deepEqual([...shares.docs.keys()], [renewal.id]);
  assert.equal(shares.docs.get(renewal.id).reviewReason, null);
});
test("crossing periods and credits from an old invoice cannot create an automatic migrated transfer", async () => {
  const crossing = invoiceFor("in_crossing", { created: 1769000000, lines: { data: [
    { amount: 1000, price: { id: member.priceId }, period: { start: 1767500000, end: 1770000000 } },
  ] } });
  const old = invoiceFor("in_old", { created: 1769000000, lines: { data: [
    { amount: 1000, price: { id: member.priceId }, period: { start: 1767000000, end: migratedAllocation.effectivePeriodStart } },
  ] } });
  const credited = invoiceFor("in_credited", { created: 1769000000, lines: { data: [
    { amount: -500, price: { id: member.priceId }, period: { start: 1767000000, end: migratedAllocation.effectivePeriodStart }, proration_details: { credited_items: { invoice: old.id } } },
    { amount: 1500, price: { id: member.priceId }, period: { start: migratedAllocation.effectivePeriodStart, end: 1770000000 } },
  ] } });
  const h = stripeFor([old, crossing, credited]);
  h.stripe.subscriptions.retrieve = async () => ({ ...sub, metadata: memberRevenueMetadata(migratedAllocation, sub.customer, "migration:one") });
  const shares = memory();
  await recordMemberRevenueInvoice(crossing.id, { stripe: h.stripe, shares });
  await recordMemberRevenueInvoice(credited.id, { stripe: h.stripe, shares });
  assert.match(shares.docs.get(crossing.id).reviewReason, /review/);
  assert.match(shares.docs.get(credited.id).reviewReason, /review/);
  assert.equal(shares.docs.has(old.id), false);
  assert.equal(migratedInvoiceBoundary(old, old.lines.data, allocation), "eligible");
});
test("the migrated-cohort pause leaves existing Checkout allocations running", async () => {
  const h = stripeFor([invoiceFor()]);
  const migrated = { ...sub, id: "sub_migrated", metadata: memberRevenueMetadata(migratedAllocation, sub.customer, "migration:one") };
  h.stripe.subscriptions.list = async function* () { yield structuredClone(sub); yield structuredClone(migrated); };
  const captured = [];
  const previous = process.env.MEMBER_REVENUE_MIGRATED_ENABLED;
  process.env.MEMBER_REVENUE_MIGRATED_ENABLED = "false";
  try {
    await processMemberRevenueSharing({ stripe: h.stripe, enabled: true, capture: async id => { captured.push(id); },
      settle: async () => ({}) });
    assert.deepEqual(captured, ["in_one"]);
  } finally {
    if (previous === undefined) delete process.env.MEMBER_REVENUE_MIGRATED_ENABLED;
    else process.env.MEMBER_REVENUE_MIGRATED_ENABLED = previous;
  }
});
test("Alumni switch credits recover the prior region allocation even when delivered first", async () => {
  const invoices = [invoiceFor(), invoiceFor("in_alumni", { lines: { data: [
    { amount: -500, price: member.priceId, proration_details: { credited_items: { invoice: "in_one" } } }, { amount: 1000, price: alumni.priceId },
  ] } })];
  const { stripe } = stripeFor(invoices); const records = recordsFor(); const shares = memory();
  await recordMemberRevenueInvoice("in_alumni", { stripe, records, shares });
  await recordMemberRevenueInvoice("in_alumni", { stripe, records, shares });
  const original = { ...shareFor(), ...shares.docs.get("in_one") };
  assert.equal(revenueTarget(original), 360);
  assert.equal(shares.docs.size, 1);
});
test("Member plan-change credits are not deducted twice from total revenue", async () => {
  const changed = invoiceFor("in_change", { lines: { data: [{ amount: -500, price: member.priceId, proration_details: { credited_items: { invoice: "in_one" } } }, { amount: 1500, price: member.priceId }] } });
  const { stripe } = stripeFor([invoiceFor(), changed]); const records = recordsFor(); const shares = memory();
  await recordMemberRevenueInvoice(changed.id, { stripe, records, shares });
  assert.equal(revenueTarget({ ...shareFor(), ...shares.docs.get("in_one") }) + revenueTarget({ ...shareFor(), ...shares.docs.get(changed.id) }), 1520);
});
test("missing fees wait; mismatched charges and mixed invoices are held for review", async () => {
  const invoice = invoiceFor(); invoice.charge.balance_transaction = null;
  const h = stripeFor([invoice]); const shares = memory();
  await assert.rejects(recordMemberRevenueInvoice(invoice.id, { stripe: h.stripe, shares, records: recordsFor() }), /not available/);
  assert.equal(shares.docs.size, 0);
  invoice.charge = invoiceFor().charge; invoice.charge.customer = "cus_wrong";
  await recordMemberRevenueInvoice(invoice.id, { stripe: h.stripe, shares, records: recordsFor() });
  assert.match(shares.docs.get(invoice.id).reviewReason, /review/);
});
test("transfers use actual net allocation and a source charge; repeated ticks do not repay", async () => {
  const h = stripeFor(); const shares = memory([shareFor()]);
  await settleMemberRevenueRegion(accountId, { ...h, shares, withLease });
  await settleMemberRevenueRegion(accountId, { ...h, shares, withLease });
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].body.amount, 760);
  assert.equal(h.calls[0].body.source_transaction, "ch_in_one");
  assert.equal(h.calls[0].body.destination, accountId);
});
test("ambiguous transfer retry finds the original operation even after Stripe idempotency expires", async () => {
  const h = stripeFor(); const shares = memory([shareFor()]); h.failNextTransfer();
  await assert.rejects(settleMemberRevenueRegion(accountId, { ...h, shares, withLease }), /timeout/);
  assert.ok(shares.docs.get("in_one").operation);
  await settleMemberRevenueRegion(accountId, { ...h, shares, withLease });
  assert.equal(h.calls.length, 1); assert.equal(shares.docs.get("in_one").operation, undefined);
});
test("refunds and unreimbursed fees are recovered within the same region before new transfers", async () => {
  const h = stripeFor(); const shares = memory([shareFor()]);
  await settleMemberRevenueRegion(accountId, { ...h, shares, withLease });
  shares.docs.get("in_one").refunded = 1000;
  shares.docs.set("in_two", shareFor("in_two", { paidAt: new Date("2026-02-01") }));
  shares.docs.set("other", shareFor("other", { accountId: MEMBER_REVENUE_ACCOUNTS.rotterdam }));
  await settleMemberRevenueRegion(accountId, { ...h, shares, withLease });
  assert.deepEqual(h.calls.map(c => [c.kind, c.body.amount]), [["transfer", 760], ["reversal", 760], ["transfer", 720]]);
  assert.equal(h.transfers[1].destination, accountId);
});
test("an unrecoverable regional reversal prevents further payouts and persists its retry", async () => {
  const h = stripeFor(); const shares = memory([shareFor()]);
  await settleMemberRevenueRegion(accountId, { ...h, shares, withLease });
  shares.docs.get("in_one").refunded = 1000;
  shares.docs.set("in_two", shareFor("in_two")); h.failReversals();
  await assert.rejects(settleMemberRevenueRegion(accountId, { ...h, shares, withLease }), /insufficient/);
  assert.equal(h.calls.length, 1); assert.equal(shares.docs.get("in_one").operation.kind, "reversal");
});
test("lost leases and unready connected accounts cannot transfer money", async () => {
  const h = stripeFor(); const shares = memory([shareFor()]);
  await assert.rejects(settleMemberRevenueRegion(accountId, { ...h, shares, withLease: async (_, work) => work({ assertOwned: async () => { throw new Error("lease lost"); } }) }), /lease lost/);
  h.stripe.accounts.retrieve = async () => ({ payouts_enabled: false });
  await assert.rejects(settleMemberRevenueRegion(accountId, { ...h, shares, withLease }), /cannot receive/);
  assert.equal(h.calls.length, 0);
});
test("failed invoice capture blocks that region; other regions still reconcile", async () => {
  const records = memory([{ _id: "member-revenue-subscription:sub_one", data: { ...allocation, subscriptionId: sub.id } }]);
  const h = stripeFor([invoiceFor()]); const settled = [];
  await processMemberRevenueSharing({ ...h, records, shares: memory(), enabled: true, capture: async () => { throw new Error("fees missing"); }, settle: async id => { settled.push(id); return {}; } });
  assert.ok(!settled.includes(accountId)); assert.equal(settled.length, 4);
});
test("disabled maintenance and connected-account webhooks perform no work", async () => {
  await processMemberRevenueMaintenance({ enabled: false, withLease: () => assert.fail("disabled") });
  await captureMemberRevenueEvent({ account: accountId }, "netherlands", { stripe: {} });
});

const feeRow = (values = {}) => ({ amount: "0.07", tax: "0.01", currency: "EUR", incurred_by: "in_one", incurred_by_type: "invoice", balance_transaction_id: "txn_fee", fee_transaction_id: "txn_fee", settled_via: "balance", ...values });
test("fee reports avoid charging processing fees twice, include tax once and round after summing", () => {
  const result = allocateMemberFees([feeRow({ amount: "0.40", balance_transaction_id: "txn_in_one" }), feeRow(), feeRow({ amount: "0.004" }), feeRow({ amount: "0.004" }), feeRow({ incurred_by: "in_alumni" })], [shareFor()]);
  assert.equal(result.allocations.length, 1); assert.equal(result.allocations[0].amount, 8);
  assert.equal(result.unattributed, 0);
});
test("regional overhead, negative fee adjustments and unattributed fees remain explicit", () => {
  const result = allocateMemberFees([feeRow({ incurred_by: accountId, incurred_by_type: "account", amount: "2.00" }), feeRow({ amount: "-0.07" }), feeRow({ incurred_by: "" }), feeRow({ settled_via: "credit" })], [shareFor()]);
  assert.deepEqual(result.allocations.map(a => a.amount), [200, -7]); assert.equal(result.unattributed, 2);
  assert.throws(() => allocateMemberFees([feeRow({ amount: "invalid" })], [shareFor()]), /Invalid/);
});
test("CSV parsing handles quotes and file downloads cannot leak credentials to other hosts", async () => {
  const rows = await parseMemberFeeReport('amount,incurred_by\n"0.20","in_one"\n');
  assert.equal(rows[0].amount, "0.20");
  let calls = 0;
  await assert.rejects(downloadMemberFeeReport({ url: "https://evil.test/report" }, { key: "test", fetchFile: () => { calls++; } }), /Invalid/);
  assert.equal(calls, 0);
  assert.equal(await downloadMemberFeeReport({ url: "https://files.stripe.com/report" }, { key: "test", fetchFile: async (_, options) => { assert.equal(options.redirect, "error"); return { ok: true, text: async () => "csv" }; } }), "csv");
});
test("a monthly fee report is applied once and replay replaces totals without resetting fees", async () => {
  const h = stripeFor(); const shares = memory([shareFor()]); const records = memory();
  let runs = 0, savedRun;
  h.stripe.reporting = { reportTypes: { retrieve: async () => ({ data_available_end: 1800000000 }) }, reportRuns: {
    list: async function* () { if (savedRun) yield savedRun; },
    create: async (body) => { runs++; savedRun = { ...body, id: "frr_one", status: "succeeded", result: {} }; return savedRun; },
  } };
  const lease = async (key, work) => { if (!records.docs.has(key)) records.docs.set(key, { _id: key }); return work({ record: records.docs.get(key), assertOwned: async () => {} }); };
  const csv = Object.keys(feeRow()).join(',') + '\n' + Object.values(feeRow()).join(',') + '\n';
  const deps = { ...h, shares, records, enabled: true, now: new Date("2026-02-06"), withLease: lease, download: async () => csv };
  await processMemberRevenueFees(deps); await processMemberRevenueFees(deps);
  assert.equal(runs, 1); assert.equal(shares.docs.get("in_one").extraFees["2026-01"], 7);
});


test("partial disputes recover only the disputed share and won disputes restore it", async () => {
  const invoice = invoiceFor(); invoice.charge.disputed = true;
  const h = stripeFor([invoice]); const records = recordsFor(); const shares = memory();
  let status = "needs_response";
  h.stripe.disputes = { list: () => (async function* () { yield { amount: 500, currency: "eur", status }; })() };
  await recordMemberRevenueInvoice(invoice.id, { ...h, records, shares });
  assert.equal(revenueTarget({ ...shareFor(), ...shares.docs.get(invoice.id) }), 360);
  status = "won";
  await recordMemberRevenueInvoice(invoice.id, { ...h, records, shares });
  assert.equal(revenueTarget({ ...shareFor(), ...shares.docs.get(invoice.id) }), 760);
});
test("fee references follow refunds to their enrolled payment and cache repeated lookups", async () => {
  let calls = 0;
  const row = feeRow({ incurred_by: "re_one", incurred_by_type: "refund" });
  const rows = await resolveMemberFeeReferences([row, row], { refunds: { retrieve: async () => { calls++; return { charge: "ch_in_one" }; } } });
  assert.equal(calls, 1);
  assert.equal(allocateMemberFees(rows, [shareFor()]).allocations[0].amount, 14);
});
test("wrong Stripe mode prevents the worker from reaching a transfer", async () => {
  const h = stripeFor(); h.stripe.balance.retrieve = async () => ({ livemode: false });
  await assert.rejects(processMemberRevenueSharing({ ...h, enabled: true, records: memory(), shares: memory() }), /Wrong Stripe mode/);
  assert.equal(h.calls.length, 0);
});
test("zero-cash Member prorations are visible for accounting review", async () => {
  const zero = invoiceFor("in_zero", { amount_paid: 0, charge: null, lines: { data: [
    { amount: -1000, price: member.priceId, proration_details: { credited_items: { invoice: "in_one" } } },
    { amount: 1000, price: member.priceId },
  ] } });
  const h = stripeFor([invoiceFor(), zero]); const shares = memory();
  await recordMemberRevenueInvoice(zero.id, { ...h, records: recordsFor(), shares });
  assert.match(shares.docs.get(zero.id).reviewReason, /review/);
});

test("regional fee credits offset regional debt exactly once", async () => {
  const h = stripeFor();
  const shares = memory([
    shareFor("in_refunded", { refunded: 1000 }),
    shareFor("fee:debit", { chargeId: undefined, invoiceId: undefined, gross: 0, processingFee: 0, extraFees: { month: 100 } }),
    shareFor("fee:credit", { chargeId: undefined, invoiceId: undefined, gross: 0, processingFee: 0, extraFees: { month: -50 } }),
    shareFor("in_new"),
  ]);
  await settleMemberRevenueRegion(accountId, { ...h, shares, withLease });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.amount, 670);
});


test("a new process rebuilds invoice state from Stripe and recovers an ambiguous transfer without a local ledger", async () => {
  const h = stripeFor([invoiceFor()]);
  let shares = createRevenueSnapshot(h.stripe);
  await recordMemberRevenueInvoice("in_one", { stripe: h.stripe, shares });
  h.failNextTransfer();
  await assert.rejects(settleMemberRevenueRegion(accountId, { ...h, shares, withLease }), /ambiguous/);
  assert.ok((await h.stripe.invoices.retrieve("in_one")).metadata.bgsnlPendingRevenueOperation);
  shares = createRevenueSnapshot(h.stripe);
  await recordMemberRevenueInvoice("in_one", { stripe: h.stripe, shares });
  await settleMemberRevenueRegion(accountId, { ...h, shares, withLease });
  assert.equal(h.calls.length, 1);
  assert.equal((await h.stripe.invoices.retrieve("in_one")).metadata.bgsnlPendingRevenueOperation, "");
});

test("superseded pending instructions cannot pay a region twice", async () => {
  const h = stripeFor();
  const shares = memory([shareFor()]);
  await settleMemberRevenueRegion(accountId, { ...h, shares, withLease });
  await shares.updateOne({ _id: "in_one" }, { $set: { operation: { id: "old-worker", kind: "transfer", amount: 760, before: 0 } } });
  await settleMemberRevenueRegion(accountId, { ...h, shares, withLease });
  assert.equal(h.calls.length, 1);
});
