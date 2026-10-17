import "dotenv/config";
import mongoose from "mongoose";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStripeClient } from "../util/config/stripe.js";
import { MEMBER_REVENUE_PLATFORM } from "../util/config/member-revenue.js";
import { readMemberRevenueAllocation } from "../services/subscriptions/stripe-revenue-state.js";
import { pendingMemberTransfer } from "../services/subscriptions/pending-payments.js";

// These five invoices had repeated balance_insufficient responses in the
// production worker log on 2026-10-17, before balanceDeferred metadata existed.
export const LEGACY_CONFIRMED_BALANCE_INVOICES = new Set([
  "in_1UP444AShinXgMFZB7fAGKmm",
  "in_1UNufaAShinXgMFZRmlYlrI5",
  "in_1UNt1yAShinXgMFZvxh9yzEz",
  "in_1UN65PAShinXgMFZtWnkZyPl",
  "in_1UPg4ZAShinXgMFZ1ygy2bTS",
]);

export async function collectPendingStripeFunds({ stripe, legacyConfirmed = LEGACY_CONFIRMED_BALANCE_INVOICES } = {}) {
  const rows = [];
  const seenLegacy = new Set();
  let enrolledSubscriptions = 0;
  let paidInvoices = 0;
  for await (const sub of stripe.subscriptions.list({ status: "all", limit: 100 })) {
    const allocation = readMemberRevenueAllocation(sub);
    if (!allocation || !allocation.livemode) continue;
    enrolledSubscriptions++;
    for await (const invoice of stripe.invoices.list({ subscription: sub.id, status: "paid", limit: 100 })) {
      paidInvoices++;
      if (legacyConfirmed.has(invoice.id)) seenLegacy.add(invoice.id);
      const raw = invoice.metadata?.bgsnlPendingRevenueOperation;
      if (!raw) continue;
      const operation = JSON.parse(raw);
      if (operation.kind !== "transfer" || operation.balanceDeferred !== true && !legacyConfirmed.has(invoice.id)) continue;
      if (!Number.isSafeInteger(operation.before) || operation.before < 0) throw new Error(`Invalid pending transfer baseline: ${invoice.id}`);
      const transfers = [];
      for await (const item of stripe.transfers.list({ transfer_group: `bgsnl-member:${invoice.id}`,
        destination: allocation.accountId, limit: 100 })) transfers.push(item);
      if (transfers.some(item => item.metadata?.bgsnlRevenueOperation === operation.id) ||
          transfers.reduce((sum, item) => sum + item.amount - item.amount_reversed, 0) !== operation.before) continue;
      rows.push(pendingMemberTransfer({ _id: invoice.id, subscriptionId: sub.id,
        accountId: allocation.accountId, region: allocation.region, livemode: true,
        paidAt: new Date((invoice.status_transitions?.paid_at || invoice.created) * 1000),
        operation: { ...operation, balanceDeferred: true } }));
    }
  }
  return { enrolledSubscriptions, paidInvoices, seenLegacy: [...seenLegacy], rows };
}

export async function backfillPendingStripeFunds({ stripe, collection, apply = false,
  legacyConfirmed = LEGACY_CONFIRMED_BALANCE_INVOICES, expectedCount } = {}) {
  const audit = await collectPendingStripeFunds({ stripe, legacyConfirmed });
  if (expectedCount !== undefined && audit.rows.length !== expectedCount) throw new Error("Pending transfer count changed; rerun dry-run");
  const result = { enrolledSubscriptions: audit.enrolledSubscriptions, paidInvoices: audit.paidInvoices,
    pending: audit.rows.length, rows: audit.rows.map(row => ({ invoiceId: row._id, region: row.region, amountCents: row.amountCents })),
    inserted: 0, updated: 0, resolvedDuringApply: 0 };
  if (!apply) return result;
  await collection.createIndex({ reason: 1, type: 1, createdAt: -1 });
  for (const row of audit.rows) {
    // Recheck immediately before each write; a worker may have settled it since the scan.
    const invoice = await stripe.invoices.retrieve(row._id);
    const operation = invoice.metadata?.bgsnlPendingRevenueOperation ? JSON.parse(invoice.metadata.bgsnlPendingRevenueOperation) : null;
    const current = [];
    for await (const item of stripe.transfers.list({ transfer_group: `bgsnl-member:${row._id}`,
      destination: row.accountId, limit: 100 })) current.push(item);
    if (!operation || operation.kind !== "transfer" || operation.balanceDeferred !== true && !legacyConfirmed.has(row._id) ||
        current.some(item => item.metadata?.bgsnlRevenueOperation === operation.id) ||
        current.reduce((sum, item) => sum + item.amount - item.amount_reversed, 0) !== operation.before) {
      result.resolvedDuringApply++;
      continue;
    }
    const now = new Date();
    const verified = pendingMemberTransfer({ _id: row._id, subscriptionId: row.subscriptionId,
      accountId: row.accountId, region: row.region, livemode: true, paidAt: row.invoicePaidAt,
      operation: { ...operation, balanceDeferred: true } });
    const { _id, ...fields } = verified;
    const write = await collection.updateOne({ _id }, { $set: { ...fields, updatedAt: now },
      $setOnInsert: { createdAt: now } }, { upsert: true });
    result.inserted += write.upsertedCount || 0;
    result.updated += write.matchedCount || 0;
    // Close the read/write race with a worker that transfers after the first check.
    const after = await stripe.invoices.retrieve(_id);
    const afterOperation = after.metadata?.bgsnlPendingRevenueOperation ? JSON.parse(after.metadata.bgsnlPendingRevenueOperation) : null;
    const afterTransfers = [];
    for await (const item of stripe.transfers.list({ transfer_group: `bgsnl-member:${_id}`,
      destination: row.accountId, limit: 100 })) afterTransfers.push(item);
    if (!afterOperation || afterOperation.kind !== "transfer" || afterOperation.id !== fields.operationId ||
        afterOperation.balanceDeferred !== true && !legacyConfirmed.has(_id) ||
        afterTransfers.some(item => item.metadata?.bgsnlRevenueOperation === fields.operationId) ||
        afterTransfers.reduce((sum, item) => sum + item.amount - item.amount_reversed, 0) !== afterOperation.before) {
      await collection.deleteOne({ _id, operationId: fields.operationId });
      result.resolvedDuringApply++;
    }
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--apply" && !arg.startsWith("--expect-db=") && !arg.startsWith("--expect-count="))) throw new Error("Unknown backfill argument");
  const apply = args.includes("--apply");
  const expectedDatabase = args.find(arg => arg.startsWith("--expect-db="))?.slice(12);
  const expectedCount = args.find(arg => arg.startsWith("--expect-count="))?.slice(15);
  if (apply && (!expectedDatabase || expectedCount === undefined || !/^(0|[1-9]\d*)$/.test(expectedCount))) {
    throw new Error("Apply requires --expect-db and --expect-count from dry-run");
  }
  const stripe = createStripeClient("netherlands");
  const [platform, balance] = await Promise.all([stripe.accounts.retrieve(), stripe.balance.retrieve()]);
  if (platform.id !== MEMBER_REVENUE_PLATFORM || !balance.livemode) throw new Error("This migration requires the live BGSNL Stripe platform");
  const uri = `mongodb+srv://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASS)}@${process.env.DB}`;
  await mongoose.connect(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 15000 });
  try {
    if (expectedDatabase && mongoose.connection.name !== expectedDatabase) throw new Error("Unexpected database name");
    const result = await backfillPendingStripeFunds({ stripe, collection: mongoose.connection.db.collection("pendingPayments"),
      apply, expectedCount: expectedCount === undefined ? undefined : Number(expectedCount) });
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", database: mongoose.connection.name, ...result }, null, 2));
  } finally { await mongoose.disconnect(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error("Pending transfer backfill failed:", error.message); process.exitCode = 1; });
}
