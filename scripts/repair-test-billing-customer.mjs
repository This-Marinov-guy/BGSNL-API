// Repair a copied development account, never silently replace a live customer.
/* eslint-disable no-process-env -- This guarded CLI deliberately validates its development environment. */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Stripe from "stripe";

export function assertTestEnvironment(env) {
  if (env.APP_ENV !== "dev" || env.NODE_ENV === "production" || !env.DB?.startsWith("dev.") ||
      !/^sk_test_[A-Za-z0-9]+$/.test(env.STRIPE_NL_SECRET_KEY || "")) {
    throw new Error("This repair requires the development database and a Stripe test key.");
  }
}

export async function repairTestCustomer({ env, account, stripe, collection, apply = false }) {
  assertTestEnvironment(env);
  if (!account || account.status !== "active" || account.subscription?.id) {
    throw new Error("Only active development accounts without a linked subscription can be repaired.");
  }
  const previousId = account.subscription?.customerId;
  if (!previousId) throw new Error("No stale customer reference to repair.");
  try {
    const existing = await stripe.customers.retrieve(previousId);
    if (!existing.deleted) {
      if (existing.livemode !== false) throw new Error("Refusing a live-mode customer.");
      return { changed: false, reason: "Customer already exists in test mode", customerId: previousId };
    }
  } catch (error) {
    // Network/permission failures are not evidence that a customer is missing.
    if (error.code !== "resource_missing" || error.param !== "id") throw error;
  }
  if (!apply) return { changed: false, repairable: true, accountId: String(account._id), previousCustomerId: previousId };
  const idempotencyKey = `dev-customer-repair:${createHash("sha256").update(`${account._id}:${previousId}`).digest("hex")}`;
  const customer = await stripe.customers.create({ email: account.email, metadata: {
    bgsnlDevelopmentAccountId: String(account._id), bgsnlPreviousCustomerId: previousId,
    bgsnlPurpose: "development-billing-repair",
  } }, { idempotencyKey });
  if (customer.livemode !== false) throw new Error("Refusing a live-mode customer.");
  const result = await collection.updateOne({ _id: account._id, status: "active",
    "subscription.customerId": previousId, "subscription.id": { $in: [null, ""] },
  }, { $set: { "subscription.customerId": customer.id, "subscription.stripeRegion": "netherlands" } });
  if (result.modifiedCount !== 1) throw new Error("Account changed during repair; no account data was overwritten.");
  return { changed: true, accountId: String(account._id), previousCustomerId: previousId, customerId: customer.id };
}

async function main() {
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  dotenv.config({ path: path.join(directory, ".env.dev") });
  const args = process.argv.slice(2);
  const accountId = args.find(value => value.startsWith("--account="))?.slice(10);
  if (!accountId || args.some(value => value !== "--apply" && !value.startsWith("--account="))) {
    throw new Error("Usage: APP_ENV=dev node scripts/repair-test-billing-customer.mjs --account=<id> [--apply]");
  }
  assertTestEnvironment(process.env);
  const stripe = new Stripe(process.env.STRIPE_NL_SECRET_KEY, { apiVersion: "2022-08-01", timeout: 20000, maxNetworkRetries: 1 });
  try {
    await mongoose.connect(`mongodb+srv://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASS)}@${process.env.DB}`, { serverSelectionTimeoutMS: 10000 });
    const matches = [];
    for (const name of ["alumniUsers", "memberUsers"]) {
      const collection = mongoose.connection.collection(name);
      const account = await collection.findOne({ _id: accountId }, { projection: { email: 1, status: 1, subscription: 1 } });
      if (account) matches.push({ account, collection });
    }
    if (matches.length !== 1) throw new Error("Expected exactly one development account.");
    console.log(JSON.stringify(await repairTestCustomer({ env: process.env, stripe, ...matches[0], apply: args.includes("--apply") })));
  } finally { await mongoose.disconnect(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
