import "dotenv/config";
import mongoose from "mongoose";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import MemberUser from "../models/MemberUser.js";
import AlumniUser from "../models/AlumniUser.js";
import { createStripeClient } from "../util/config/stripe.js";
import { readMemberRevenueAllocation } from "../services/subscriptions/stripe-revenue-state.js";
import { hasMemberConnectAllocation } from "../services/subscriptions/connected.js";

export function connectedBackfillChange(doc, type, allocation) {
  const sub = doc.subscription;
  if (sub != null && (typeof sub !== "object" || Array.isArray(sub))) throw new Error("Malformed subscription; review before backfill");
  const connected = type === "member" && hasMemberConnectAllocation(sub, allocation);
  if (sub?.connected === connected) return null;
  // Match the exact subscription snapshot to avoid overwriting a concurrent
  // checkout, reconciliation or another correction after the dry-run read.
  return { filter: { _id: doc._id, subscription: Object.hasOwn(doc, "subscription") ? sub : { $exists: false } },
    update: { $set: sub == null ? { subscription: { connected } } : { "subscription.connected": connected } } };
}

export async function backfillSubscriptionConnected({ apply = false, backupPath, members = MemberUser.collection,
  alumni = AlumniUser.collection, records, saveBackup = writeFile } = {}) {
  const allocations = new Map();
  if (records) { // Injected legacy fixtures only; production reads Stripe.
    for await (const record of records.find({ _id: /^member-revenue-subscription:/ }, { projection: { data: 1 } })) allocations.set(record.data?.subscriptionId, record.data);
  } else {
    for await (const sub of createStripeClient("netherlands").subscriptions.list({ status: "all", limit: 100 })) {
      const allocation = readMemberRevenueAllocation(sub);
      if (allocation) allocations.set(sub.id, allocation);
    }
  }
  const pending = [];
  const summary = { member: { scanned: 0, changes: 0, connected: 0 }, alumni: { scanned: 0, changes: 0, connected: 0 }, modified: 0, conflicts: 0 };
  for (const [type, collection] of [["member", members], ["alumni", alumni]]) {
    // Raw collections avoid schema defaults hiding fields missing in MongoDB.
    for await (const doc of collection.find({}, { projection: { subscription: 1 } })) {
      summary[type].scanned++;
      const allocation = allocations.get(doc.subscription?.id);
      const change = connectedBackfillChange(doc, type, allocation);
      if (type === "member" && hasMemberConnectAllocation(doc.subscription, allocation)) summary[type].connected++;
      if (!change) continue;
      summary[type].changes++;
      pending.push({ type, collection, doc, change });
    }
  }
  if (apply && pending.length) {
    if (!backupPath) throw new Error("--backup=<path> is required with --apply");
    await saveBackup(backupPath, JSON.stringify({ createdAt: new Date(), records: pending.map(({ type, doc }) => ({
      type, id: doc._id, subscriptionPresent: Object.hasOwn(doc, "subscription"), subscription: doc.subscription,
    })) }, null, 2), { flag: "wx", mode: 0o600 });
    for (const { collection, change } of pending) {
      const result = await collection.updateOne(change.filter, change.update);
      summary.modified += result.modifiedCount;
      if (!result.matchedCount) summary.conflicts++;
    }
  }
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--apply" && !arg.startsWith("--backup="))) throw new Error("Unknown backfill argument");
  const apply = args.includes("--apply");
  const backupPath = args.find(arg => arg.startsWith("--backup="))?.slice(9);
  mongoose.set("strictQuery", true);
  await mongoose.connect(`mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`, { serverSelectionTimeoutMS: 15000 });
  try {
    const summary = await backfillSubscriptionConnected({ apply, backupPath });
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", database: mongoose.connection.name, ...summary }));
    if (summary.conflicts) process.exitCode = 1;
  } finally { await mongoose.disconnect(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async () => {
    console.error("Connected-flag backfill failed; inspect configuration/backup and retry. Stripe is read-only in this backfill.");
    process.exitCode = 1;
    await mongoose.disconnect();
  });
}
