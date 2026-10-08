import { matchesRecord, recordQuery, updateRecord } from "../storage/record-operations.js";
import { validMemberRevenueAllocation } from "../../util/config/member-revenue.js";
import { stripeId } from "../../util/subscriptions/policy.js";

// New Checkout allocations use v1; prospective existing-Member migrations use
// v2 with an explicit service-period and invoice-creation boundary.
export function memberRevenueMetadata(allocation, customerId, operationId) {
  if (!allocation) return {};
  if (!validMemberRevenueAllocation(allocation)) throw new Error("Invalid regional subscription allocation");
  return { bgsnlRevenueOperation: operationId,
    bgsnlRevenueAllocation: JSON.stringify({ version: allocation.version, accountId: allocation.accountId, region: allocation.region, platformPercent: allocation.platformPercent, livemode: allocation.livemode, customerId, operationId,
      ...(allocation.version === 2 ? { effectivePeriodStart: allocation.effectivePeriodStart, enrolledAt: allocation.enrolledAt } : {}) }) };
}
export function readMemberRevenueAllocation(sub) {
  const raw = sub.metadata?.bgsnlRevenueAllocation;
  if (!raw) return null;
  let allocation;
  try { allocation = JSON.parse(raw); } catch { throw new Error("Invalid Stripe subscription allocation"); }
  if (!validMemberRevenueAllocation(allocation) || allocation.customerId !== stripeId(sub.customer) ||
      allocation.livemode !== sub.livemode || allocation.operationId !== sub.metadata.bgsnlRevenueOperation) {
    throw new Error("Member revenue subscription ownership mismatch");
  }
  return { ...allocation, subscriptionId: sub.id, created: sub.created };
}

// Rebuilt from Stripe for EVERY sweep. No invoice ledger/cache in Mongo or Redis.
// Only an in-flight money-movement instruction is durable, on its Stripe invoice.
export function createRevenueSnapshot(stripe) {
  const documents = new Map();
  return {
    findById: async (id) => structuredClone(documents.get(id) || null),
    find: (filter) => recordQuery(async () => [...documents.values()].filter((row) => matchesRecord(row, filter)).map((row) => structuredClone(row))),
    findOne: (filter) => recordQuery(async () => [...documents.values()].filter((row) => matchesRecord(row, filter)).map((row) => structuredClone(row)), true),
    async updateOne({ _id }, update) {
      if (update.$set?.operation || update.$unset?.operation) {
        if (!String(_id).startsWith("in_")) throw new Error("An invoice is required for a revenue operation");
        await stripe.invoices.update(_id, { metadata: {
          bgsnlPendingRevenueOperation: update.$set?.operation ? JSON.stringify(update.$set.operation) : "",
        } });
      }
      const base = documents.get(_id) || { _id, gross: 0, refunded: 0, processingFee: 0, extraFees: {}, creditedByInvoice: {} };
      documents.set(_id, updateRecord(base, update));
      return { matchedCount: 1 };
    },
  };
}
