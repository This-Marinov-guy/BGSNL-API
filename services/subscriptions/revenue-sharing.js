import { createHash } from "node:crypto";
import { readMemberRevenueAllocation, createRevenueSnapshot } from "./stripe-revenue-state.js";
import { DEFAULT_REGION } from "../../util/config/defines.js";
import { createStripeClient } from "../../util/config/stripe.js";
import { MEMBER_REVENUE_PLATFORM, MEMBER_REVENUE_ACCOUNTS, memberRevenueEnabled, memberRevenueLiveMode } from "../../util/config/member-revenue.js";
import { invoiceSubscriptionId, planForPrice, stripeId } from "../../util/subscriptions/policy.js";
import { withBillingLease } from "./lease.js";

const cents = (value) => Number.isSafeInteger(value) && value >= 0;
const creditTotal = (record) => Object.values(record.creditedByInvoice || {}).reduce((sum, value) => sum + value, 0);
const extraFeeTotal = (record) => Object.values(record.extraFees || {}).reduce((sum, value) => sum + value, 0);
export function revenueTarget(record) {
  if (![record.gross, record.refunded, record.processingFee, record.disputedAmount || 0, ...Object.values(record.creditedByInvoice || {})].every(cents) ||
      !Object.values(record.extraFees || {}).every(Number.isSafeInteger)) throw new Error("Invalid member revenue amounts");
  const retainedGross = Math.max(0, record.gross - record.refunded - (record.disputedAmount || 0) - creditTotal(record));
  // Round the platform share, then assign the remaining cents to the region.
  return retainedGross - Math.round(retainedGross * 0.2) - record.processingFee - extraFeeTotal(record);
}

export async function verifyRevenuePlatform(stripe, livemode = memberRevenueLiveMode()) {
  const account = await stripe.accounts.retrieve();
  if ((await stripe.balance.retrieve()).livemode !== livemode) throw new Error("Wrong Stripe mode for member revenue sharing");
  if (livemode && account.id !== MEMBER_REVENUE_PLATFORM) throw new Error("Wrong membership revenue platform");
}

// The Stripe subscription is the durable source of the original allocation.
export async function registerMemberRevenueSubscription(sub) {
  return readMemberRevenueAllocation(sub);
}

const invoiceLines = async (stripe, invoice) => {
  if (!invoice.lines?.has_more) return invoice.lines?.data || [];
  const lines = [];
  for await (const line of stripe.invoices.listLineItems(invoice.id, { limit: 100 })) lines.push(line);
  return lines;
};
const linePrice = (line) => stripeId(line.price || line.pricing?.price_details?.price);
const lineSubscription = (line) => stripeId(line.subscription || line.parent?.subscription_item_details?.subscription);
const creditedInvoice = (line) => stripeId(line.proration_details?.credited_items?.invoice || line.parent?.subscription_item_details?.proration_details?.credited_items?.invoice);

export async function recordMemberRevenueInvoice(invoiceId, { stripe = createStripeClient(DEFAULT_REGION), shares = createRevenueSnapshot(stripe), visiting = new Set(), assertOwned = async () => {} } = {}) {
  if (visiting.has(invoiceId)) throw new Error("Circular invoice credit reference");
  visiting.add(invoiceId);
  const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ["charge.balance_transaction"] });
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId || invoice.status !== "paid") return null;
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const allocation = await registerMemberRevenueSubscription(sub);
  if (!allocation || invoice.livemode !== allocation.livemode || stripeId(invoice.customer) !== allocation.customerId) return null;
  const lines = await invoiceLines(stripe, invoice);
  // A Member -> Alumni proration credits the prior Member invoice. Recover
  // that region's share even though the new Alumni invoice earns no payout.
  const credits = new Map();
  for (const line of lines) {
    if (line.amount < 0 && planForPrice(linePrice(line))?.type === "member" && creditedInvoice(line)) {
      const id = creditedInvoice(line);
      credits.set(id, (credits.get(id) || 0) - line.amount);
    }
  }
  let memberCredits = 0;
  for (const [id, amount] of credits) {
    // Webhooks and Stripe lists can arrive newest first. Establish the credited
    // statement before applying its adjustment, including on the first sweep.
    if (!await shares.findById(id)) await recordMemberRevenueInvoice(id, { stripe, shares, visiting, assertOwned });
    const original = await shares.findById(id);
    if (!original || original.reviewReason || original.accountId !== allocation.accountId || original.subscriptionId !== subscriptionId || !cents(amount)) {
      throw new Error("Member proration credit requires review");
    }
    await assertOwned();
    await shares.updateOne({ _id: id }, { $set: { [`creditedByInvoice.${invoice.id}`]: amount, checkedAt: new Date() } });
    memberCredits += amount;
  }
  const positive = lines.filter((line) => line.amount > 0);
  if (!positive.some((line) => planForPrice(linePrice(line))?.type === "member")) return null;
  const review = positive.some((line) => planForPrice(linePrice(line))?.type !== "member" || (lineSubscription(line) && lineSubscription(line) !== subscriptionId)) ||
    (invoice.amount_paid === 0 && memberCredits > 0) || invoice.currency !== "eur" || !cents(invoice.amount_paid) || !!invoice.paid_out_of_band ||
    lines.some((line) => line.amount < 0 && planForPrice(linePrice(line))?.type === "member" && !creditedInvoice(line));
  let charge = invoice.charge;
  if (typeof charge === "string") charge = await stripe.charges.retrieve(charge, { expand: ["balance_transaction"] });
  if (!charge && invoice.payment_intent) {
    const intent = await stripe.paymentIntents.retrieve(stripeId(invoice.payment_intent), { expand: ["latest_charge.balance_transaction"] });
    charge = intent.latest_charge;
  }
  if (!invoice.amount_paid && !review) return null;
  let transaction = charge?.balance_transaction;
  if (typeof transaction === "string") transaction = await stripe.balanceTransactions.retrieve(transaction);
  if (!review && (!charge || !transaction)) throw new Error("Membership payment fees are not available yet");
  const invalidPayment = !review && (!charge.paid || !charge.captured || charge.livemode !== allocation.livemode ||
    stripeId(charge.customer) !== allocation.customerId || stripeId(charge.invoice) !== invoice.id ||
    charge.currency !== "eur" || transaction.currency !== "eur" ||
    charge.amount !== invoice.amount_paid || transaction.amount !== charge.amount ||
    !cents(transaction.fee) || !cents(charge.amount_refunded) ||
    !!charge.transfer || !!charge.transfer_data || !!charge.application_fee);
  let disputedAmount = 0;
  if (!review && !invalidPayment && charge.disputed) {
    let found = false;
    for await (const dispute of stripe.disputes.list({ charge: charge.id, limit: 100 })) {
      found = true;
      if (!cents(dispute.amount) || dispute.currency !== "eur") throw new Error("Unsupported membership dispute");
      if (!["won", "warning_closed", "warning_needs_response", "warning_under_review"].includes(dispute.status)) disputedAmount += dispute.amount;
    }
    if (!found) throw new Error("Membership dispute details are not available yet");
  }
  const fields = { livemode: allocation.livemode, accountId: allocation.accountId, region: allocation.region, subscriptionId,
    invoiceId: invoice.id, paidAt: new Date((invoice.status_transitions?.paid_at || invoice.created) * 1000),
    checkedAt: new Date(), reviewReason: review || invalidPayment ? "Unsupported invoice allocation or payment; review before transferring" : null };
  if (!fields.reviewReason) Object.assign(fields, { chargeId: charge.id, balanceTransactionId: transaction.id,
    gross: charge.amount + memberCredits, chargeAmount: charge.amount, refunded: charge.amount_refunded, processingFee: transaction.fee,
    disputed: disputedAmount > 0, disputedAmount, currency: charge.currency });
  await assertOwned();
  if (invoice.metadata?.bgsnlPendingRevenueOperation) {
    const operation = JSON.parse(invoice.metadata.bgsnlPendingRevenueOperation);
    if (!["transfer", "reversal"].includes(operation.kind) || typeof operation.id !== "string" || !cents(operation.amount) || operation.amount === 0 ||
        operation.kind === "reversal" && !operation.transferId) throw new Error("Invalid pending Stripe revenue operation");
    fields.operation = operation;
  }
  await shares.updateOne({ _id: invoice.id }, { $set: fields }, { upsert: true });
  return fields;
}

export async function captureMemberRevenueEvent(event, region, dependencies = {}) {
  if (region !== DEFAULT_REGION || event.account || !memberRevenueEnabled() || event.livemode !== memberRevenueLiveMode()) return;
  const stripe = dependencies.stripe || createStripeClient(DEFAULT_REGION);
  const object = event.data.object;
  if (event.type.startsWith("customer.subscription.")) await registerMemberRevenueSubscription(object);
  if (event.type.startsWith("invoice.") && object.status === "paid" && invoiceSubscriptionId(object)) {
    // Persist enrolment synchronously; fee retrieval and money movement belong
    // to the retrying worker so payment completion does not wait for fees.
    const sub = await stripe.subscriptions.retrieve(invoiceSubscriptionId(object));
    await registerMemberRevenueSubscription(sub);
  }
}

const operationId = (share, transfers, kind, amount, transferId = "") => createHash("sha256").update(JSON.stringify([share._id, kind, amount, transferId, transfers.map((item) => [item.id, item.amount, item.amount_reversed]).sort()])).digest("hex");
const groupFor = (id) => `bgsnl-member:${id}`;
const transferred = (items) => items.reduce((sum, item) => sum + item.amount - item.amount_reversed, 0);
const listTransfers = async (stripe, share) => {
  const items = [];
  for await (const item of stripe.transfers.list({ transfer_group: groupFor(share._id), destination: share.accountId, limit: 100 })) {
    if (item.metadata?.bgsnlRevenueInvoice !== share._id || item.currency !== "eur") throw new Error("Unexpected transfer in membership group");
    items.push(item);
  }
  return items;
};

// Persist and replay exact transfer/reversal instructions. Stripe idempotency
// keys expire; listing the stable transfer group also protects old crash retries.
async function executeOperation(stripe, share, shares, assertOwned) {
  const operation = share.operation;
  if (!operation) return;
  await assertOwned();
  if (operation.kind === "transfer") {
    const currentTransfers = await listTransfers(stripe, share);
    const existing = currentTransfers.find((item) => item.metadata?.bgsnlRevenueOperation === operation.id);
    if (existing && existing.amount !== operation.amount) throw new Error("Transfer replay amount mismatch");
    // A superseded instruction must not re-pay funds already settled by a
    // newer worker. Stable operation IDs also coalesce concurrent submissions.
    if (!existing && operation.before !== undefined && transferred(currentTransfers) !== operation.before) {
      await shares.updateOne({ _id: share._id }, { $unset: { operation: 1 } });
      share.operation = undefined;
      return;
    }
    if (!existing) await stripe.transfers.create({ amount: operation.amount, currency: "eur", destination: share.accountId,
      transfer_group: groupFor(share._id), ...(operation.source ? { source_transaction: operation.source } : {}),
      metadata: { bgsnlRevenueInvoice: share._id, bgsnlRevenueOperation: operation.id, bgsnlRegion: share.region } },
    { idempotencyKey: `member-revenue:${operation.id}` });
  } else {
    let existing;
    for await (const reversal of stripe.transfers.listReversals(operation.transferId, { limit: 100 })) {
      if (reversal.metadata?.bgsnlRevenueOperation === operation.id) existing = reversal;
    }
    if (existing && existing.amount !== operation.amount) throw new Error("Reversal replay amount mismatch");
    if (!existing && operation.before !== undefined) {
      const transfer = (await listTransfers(stripe, share)).find((item) => item.id === operation.transferId);
      if (!transfer || transfer.amount_reversed !== operation.before) {
        await shares.updateOne({ _id: share._id }, { $unset: { operation: 1 } });
        share.operation = undefined;
        return;
      }
    }
    if (!existing) await stripe.transfers.createReversal(operation.transferId, { amount: operation.amount,
      metadata: { bgsnlRevenueOperation: operation.id, bgsnlRevenueInvoice: share._id } },
    { idempotencyKey: `member-revenue:${operation.id}` });
  }
  await assertOwned();
  await shares.updateOne({ _id: share._id }, { $unset: { operation: 1 } });
  share.operation = undefined;
}

export async function settleMemberRevenueRegion(accountId, { stripe = createStripeClient(DEFAULT_REGION), shares = createRevenueSnapshot(stripe), withLease = withBillingLease, coordinatorAssert = async () => {} } = {}) {
  if (!Object.values(MEMBER_REVENUE_ACCOUNTS).includes(accountId)) throw new Error("Unknown member revenue recipient");
  return withLease(`member-revenue-settlement:${accountId}`, async ({ assertOwned: regionalAssert }) => {
    const assertOwned = async () => { await coordinatorAssert(); await regionalAssert(); };
    const account = await stripe.accounts.retrieve(accountId);
    if (account.capabilities?.transfers !== "active" || !account.payouts_enabled) throw new Error("Regional account cannot receive transfers");
    const all = await shares.find({ accountId, livemode: memberRevenueLiveMode() }).sort({ paidAt: 1, _id: 1 }).lean();
    // Negative targets (for example fees retained after a full refund) are
    // recovered from this region's other invoices, never from another region.
    let debt = all.filter((item) => !item.reviewReason).reduce((sum, item) => sum + Math.max(0, -revenueTarget(item)), 0);
    const feeCredits = all.filter(item => !item.reviewReason && !item.chargeId)
      .reduce((sum, item) => sum + Math.max(0, revenueTarget(item)), 0);
    const remainingCredit = Math.max(0, feeCredits - debt);
    debt = Math.max(0, debt - feeCredits);
    let credit = remainingCredit;
    let changes = 0;
    const pending = [];
    for (const share of all) {
      // A previously submitted operation is resolved before recalculating its
      // target, including when new invoice data requires manual review.
      if (share.operation) await executeOperation(stripe, share, shares, assertOwned);
      if (share.reviewReason || !share.chargeId) continue;
      let target = Math.max(0, revenueTarget(share));
      const offset = Math.min(debt, target); debt -= offset; target -= offset;
      target += credit; credit = 0;
      const transfers = await listTransfers(stripe, share);
      pending.push({ share, target, transfers, delta: target - transferred(transfers) });
    }
    // Recover excess funds before paying any new allocation. A failed reversal
    // stops this region's settlement and is retried with its persisted operation.
    pending.sort((a, b) => a.delta - b.delta);
    for (const { share, target, transfers, delta: initialDelta } of pending) {
      if (changes >= 25) break;
      let delta = initialDelta;
      if (delta > 0) {
        share.operation = { id: operationId(share, transfers, "transfer", delta), kind: "transfer", amount: delta, before: transferred(transfers),
          ...(!transfers.length && delta <= share.chargeAmount ? { source: share.chargeId } : {}) };
        await assertOwned();
        await shares.updateOne({ _id: share._id }, { $set: { operation: share.operation } });
        await executeOperation(stripe, share, shares, assertOwned);
      } else if (delta < 0) {
        for (const transfer of transfers) {
          const amount = Math.min(-delta, transfer.amount - transfer.amount_reversed);
          if (!amount) continue;
          share.operation = { id: operationId(share, transfers, "reversal", amount, transfer.id), kind: "reversal", amount, transferId: transfer.id, before: transfer.amount_reversed };
          await assertOwned();
          await shares.updateOne({ _id: share._id }, { $set: { operation: share.operation } });
          await executeOperation(stripe, share, shares, assertOwned);
          delta += amount;
          if (!delta) break;
        }
      }
      await assertOwned();
      await shares.updateOne({ _id: share._id }, { $set: { settledTarget: target } });
      if (initialDelta) changes++;
    }
    return { changes, unrecoveredDebt: debt, unpaidCredit: credit };
  });
}

export async function processMemberRevenueSharing({ stripe = createStripeClient(DEFAULT_REGION), shares = createRevenueSnapshot(stripe), enabled = memberRevenueEnabled(), capture = recordMemberRevenueInvoice, settle = settleMemberRevenueRegion, beforeSettle = async () => {}, assertOwned = async () => {} } = {}) {
  if (!enabled) return;
  await verifyRevenuePlatform(stripe);
  // Enrolment lives independently of member/alumni documents and is never
  // removed on profile migration or cancellation. Historical subscriptions
  // without a new Checkout allocation are not enrolled by this sweep.
  const blocked = new Set();
  for await (const sub of stripe.subscriptions.list({ status: "all", limit: 100 })) {
    let allocation;
    try { allocation = await registerMemberRevenueSubscription(sub); }
    catch { throw new Error("A Stripe allocation needs review before regional settlement"); }
    if (!allocation || allocation.livemode !== memberRevenueLiveMode()) continue;
    try {
      await assertOwned();
      const invoices = [];
      for await (const invoice of stripe.invoices.list({ subscription: sub.id, status: "paid", limit: 100 })) invoices.push(invoice);
      for (const invoice of invoices.sort((a, b) => a.created - b.created)) await capture(invoice.id, { stripe, shares, assertOwned });
    } catch (error) { blocked.add(allocation.accountId); console.error("Member revenue capture postponed", { subscriptionId: sub.id, code: error.code }); }
  }
  await assertOwned();
  await beforeSettle({ shares, blocked });
  for (const accountId of Object.values(MEMBER_REVENUE_ACCOUNTS)) {
    await assertOwned();
    if (blocked.has(accountId)) continue;
    try {
      const result = await settle(accountId, { stripe, shares, coordinatorAssert: assertOwned });
      if (result.unrecoveredDebt) console.error("Regional fees await recovery", { accountId, amount: result.unrecoveredDebt });
    } catch (error) { console.error("Member revenue settlement postponed", { accountId, code: error.code }); }
  }
}
