import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import MemberUser from "../models/MemberUser.js";
import AlumniUser from "../models/AlumniUser.js";
import { createStripeClient } from "../util/config/stripe.js";
import { MEMBER_REVENUE_ACCOUNTS, MEMBER_REVENUE_PLATFORM, validMemberRevenueAllocation } from "../util/config/member-revenue.js";
import { planForPrice, stripeId } from "../util/subscriptions/policy.js";
import { memberRevenueMetadata, readMemberRevenueAllocation } from "../services/subscriptions/stripe-revenue-state.js";
import { withBillingLease } from "../services/subscriptions/lease.js";
import { closeRedis } from "../services/storage/redis.js";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const plain = value => JSON.parse(JSON.stringify(value));
const timestamp = () => Math.floor(Date.now() / 1000);
const mongoUri = () => `mongodb+srv://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASS)}@${process.env.DB}`;

export function billingSnapshot(sub) {
  return plain({ id: sub.id, customer: stripeId(sub.customer), livemode: sub.livemode, status: sub.status,
    items: (sub.items?.data || []).map(item => ({ id: item.id, price: stripeId(item.price), quantity: item.quantity })),
    current_period_start: sub.current_period_start, current_period_end: sub.current_period_end,
    billing_cycle_anchor: sub.billing_cycle_anchor, collection_method: sub.collection_method,
    default_payment_method: stripeId(sub.default_payment_method), default_source: stripeId(sub.default_source),
    cancel_at_period_end: sub.cancel_at_period_end, cancel_at: sub.cancel_at, canceled_at: sub.canceled_at,
    trial_start: sub.trial_start, trial_end: sub.trial_end, pause_collection: sub.pause_collection,
    pending_update: sub.pending_update, schedule: stripeId(sub.schedule),
    discount: stripeId(sub.discount), discounts: sub.discounts,
    default_tax_rates: sub.default_tax_rates, application_fee_percent: sub.application_fee_percent,
    transfer_data: sub.transfer_data, on_behalf_of: stripeId(sub.on_behalf_of) });
}

export function migrationClassification(doc, sub, now = timestamp()) {
  const local = doc.subscription || {};
  if (doc.status !== "active" || !doc.roles?.includes("member")) return "not-current-member";
  if (!local.id || !local.customerId) return "missing-billing-identity";
  if (!Object.hasOwn(MEMBER_REVENUE_ACCOUNTS, doc.region)) return "unsupported-region";
  if (local.stripeRegion !== "netherlands") return "legacy-regional-billing";
  if (!sub) return "subscription-not-found";
  if (sub.livemode !== true || stripeId(sub.customer) !== local.customerId) return "ownership-mismatch";
  let allocation;
  try { allocation = readMemberRevenueAllocation(sub); } catch { return "allocation-review"; }
  if (allocation) return allocation.accountId === MEMBER_REVENUE_ACCOUNTS[doc.region] ? "already-enrolled" : "allocation-review";
  if (sub.metadata?.bgsnlRevenueOperation || sub.metadata?.bgsnlRevenueAllocation) return "allocation-review";
  if (sub.status !== "active" || sub.pause_collection || sub.pending_update || sub.schedule || sub.cancel_at_period_end || sub.cancel_at) return "subscription-state-review";
  if (sub.collection_method !== "charge_automatically") return "collection-review";
  const items = sub.items?.data || [];
  if (items.length !== 1 || items[0].quantity !== 1 || stripeId(items[0].price) !== local.priceId ||
      planForPrice(stripeId(items[0].price))?.type !== "member") return "plan-review";
  if (!Number.isSafeInteger(sub.current_period_end) || sub.current_period_end <= now + 86400) return "imminent-renewal-review";
  if (local.status !== "active" || local.connected === true) return "database-state-review";
  return "eligible";
}

const summaryOf = rows => rows.reduce((summary, row) => {
  summary.classifications[row.classification] = (summary.classifications[row.classification] || 0) + 1;
  const region = summary.regions[row.region] ||= {};
  region[row.classification] = (region[row.classification] || 0) + 1;
  return summary;
}, { classifications: {}, regions: {} });

export async function inventory({ stripe, members, alumni, now = timestamp() }) {
  const account = await stripe.accounts.retrieve();
  const balance = await stripe.balance.retrieve();
  if (account.id !== MEMBER_REVENUE_PLATFORM || !balance.livemode) throw new Error("Expected the live central Stripe platform");
  const recipients = {};
  for (const [region, id] of Object.entries(MEMBER_REVENUE_ACCOUNTS)) {
    const recipient = await stripe.accounts.retrieve(id);
    recipients[region] = { id, eligible: recipient.capabilities?.transfers === "active" && recipient.payouts_enabled === true };
  }
  const alumniIds = new Set((await alumni.find({}, { projection: { "subscription.id": 1 } }).toArray()).map(doc => doc.subscription?.id).filter(Boolean));
  const docs = await members.find({}, { projection: { status: 1, roles: 1, region: 1, subscription: 1 } }).toArray();
  const duplicates = new Set();
  const seen = new Set();
  for (const doc of docs) if (doc.subscription?.id) {
    if (seen.has(doc.subscription.id) || alumniIds.has(doc.subscription.id)) duplicates.add(doc.subscription.id);
    seen.add(doc.subscription.id);
  }
  const rows = [];
  for (const doc of docs) {
    const local = doc.subscription || {};
    let sub = null;
    if (doc.status === "active" && doc.roles?.includes("member") && local.id &&
        local.stripeRegion === "netherlands" && Object.hasOwn(MEMBER_REVENUE_ACCOUNTS, doc.region)) {
      try { sub = await stripe.subscriptions.retrieve(local.id); } catch (error) { if (error.code !== "resource_missing") throw error; }
    }
    let classification = migrationClassification(doc, sub, now);
    if (duplicates.has(local.id)) classification = "duplicate-billing-identity";
    if (classification === "eligible" && !recipients[doc.region].eligible) classification = "recipient-unavailable";
    if (classification === "eligible") {
      const customer = await stripe.customers.retrieve(local.customerId);
      if (customer.deleted || customer.id !== local.customerId) classification = "customer-review";
    }
    rows.push({ memberId: doc._id, region: doc.region || null, subscriptionId: local.id || null,
      customerId: local.customerId || null, classification,
      ...(classification === "eligible" ? { accountId: recipients[doc.region].id,
        effectivePeriodStart: sub.current_period_end, dbSubscription: plain(local),
        stripeSnapshot: billingSnapshot(sub), metadata: plain(sub.metadata || {}),
        baselineHash: hash({ dbSubscription: plain(local), stripeSnapshot: billingSnapshot(sub), metadata: plain(sub.metadata || {}) }) } : {}) });
  }
  return { version: 1, createdAt: new Date(now * 1000).toISOString(), platformAccount: account.id,
    database: mongoose.connection.name, recipients, rows, summary: summaryOf(rows) };
}

export function pilotManifest(inventoryResult) {
  const chosen = new Set();
  const earliest = Date.parse(inventoryResult.createdAt) / 1000 + 7 * 86400;
  const candidates = inventoryResult.rows.filter(row => row.classification === "eligible")
    .sort((a, b) => {
      const aSoon = a.effectivePeriodStart >= earliest;
      const bSoon = b.effectivePeriodStart >= earliest;
      return aSoon === bSoon ? a.effectivePeriodStart - b.effectivePeriodStart : aSoon ? -1 : 1;
    });
  return { ...inventoryResult, rows: candidates.filter(row => {
    if (row.classification !== "eligible" || chosen.has(row.region)) return false;
    chosen.add(row.region); return true;
  }), summary: undefined, pilot: true };
}

const assertPreserved = (before, after) => {
  if (hash(billingSnapshot(before)) !== hash(billingSnapshot(after))) throw new Error("Subscription billing fields changed during enrolment");
};

export async function applyManifest({ manifest, approvedHash, backupPath, auditPath, stripe, members,
  databaseName = mongoose.connection.name, withLease = withBillingLease }) {
  if (!approvedHash || hash(manifest) !== approvedHash) throw new Error("Approved manifest hash does not match");
  if (!backupPath || !auditPath || backupPath === auditPath) throw new Error("Distinct private backup and audit paths are required");
  if (manifest.version !== 1 || manifest.platformAccount !== MEMBER_REVENUE_PLATFORM || manifest.database !== databaseName ||
      manifest.rows.some(row => row.classification !== "eligible")) throw new Error("Invalid migration manifest");
  const age = Date.now() - Date.parse(manifest.createdAt);
  if (!Number.isFinite(age) || age > 24 * 3600 * 1000 || age < -5 * 60 * 1000) throw new Error("Migration manifest is outside its 24-hour validity window");
  const ids = new Set();
  for (const row of manifest.rows) {
    if (!row.memberId || !row.subscriptionId || !row.customerId || ids.has(row.subscriptionId) ||
        !Object.hasOwn(MEMBER_REVENUE_ACCOUNTS, row.region) || row.accountId !== MEMBER_REVENUE_ACCOUNTS[row.region] ||
        row.dbSubscription?.id !== row.subscriptionId || row.dbSubscription?.customerId !== row.customerId ||
        row.stripeSnapshot?.id !== row.subscriptionId || row.stripeSnapshot?.customer !== row.customerId ||
        row.stripeSnapshot?.current_period_end !== row.effectivePeriodStart ||
        row.baselineHash !== hash({ dbSubscription: row.dbSubscription, stripeSnapshot: row.stripeSnapshot, metadata: row.metadata })) {
      throw new Error("Invalid or duplicated migration row");
    }
    ids.add(row.subscriptionId);
  }
  const account = await stripe.accounts.retrieve();
  if (account.id !== MEMBER_REVENUE_PLATFORM || !(await stripe.balance.retrieve()).livemode) throw new Error("Wrong Stripe platform or mode");
  await writeFile(backupPath, JSON.stringify({ createdAt: new Date(), manifestHash: approvedHash,
    rows: manifest.rows.map(row => ({ memberId: row.memberId, subscriptionId: row.subscriptionId,
      dbSubscription: row.dbSubscription, metadata: row.metadata, stripeSnapshot: row.stripeSnapshot })) }, null, 2), { flag: "wx", mode: 0o600 });
  await writeFile(auditPath, "", { flag: "wx", mode: 0o600 });
  const result = { enrolled: 0, alreadyEnrolled: 0, skipped: 0, conflicts: 0 };
  for (const row of manifest.rows) {
    let outcome;
    try { outcome = await withLease(`subscription:netherlands:${row.subscriptionId}`, async ({ assertOwned }) => {
      const doc = await members.findOne({ _id: row.memberId }, { projection: { status: 1, roles: 1, region: 1, subscription: 1 } });
      const sub = await stripe.subscriptions.retrieve(row.subscriptionId);
      const currentHash = hash({ dbSubscription: plain(doc?.subscription || {}), stripeSnapshot: billingSnapshot(sub), metadata: plain(sub.metadata || {}) });
      const operationPrefix = `existing-member:${hash([row.subscriptionId, row.baselineHash]).slice(0, 32)}:`;
      if (doc?.status !== "active" || doc?.region !== row.region || !doc?.roles?.includes("member") ||
          hash(billingSnapshot(sub)) !== hash(row.stripeSnapshot)) return "conflict";
      if (currentHash !== row.baselineHash) {
        // Stripe may have committed while the DB update or response failed.
        // Resume only the exact allocation this manifest was authorized to add.
        let allocation;
        try { allocation = readMemberRevenueAllocation(sub); } catch { return "conflict"; }
        if (allocation?.version !== 2 || allocation.operationId !== `${operationPrefix}${allocation.enrolledAt}` ||
            allocation.enrolledAt < Math.floor(Date.parse(manifest.createdAt) / 1000) || allocation.customerId !== row.customerId ||
            allocation.accountId !== row.accountId || allocation.effectivePeriodStart !== row.effectivePeriodStart ||
            !doc.subscription || hash({ ...plain(doc.subscription), connected: false }) !== hash({ ...row.dbSubscription, connected: false })) return "conflict";
        if (doc.subscription.connected === true) return "alreadyEnrolled";
        await assertOwned();
        const repaired = await members.updateOne({ _id: row.memberId, subscription: doc.subscription,
          status: "active", region: row.region }, { $set: { "subscription.connected": true } });
        if (repaired.matchedCount !== 1) throw new Error("Database reconciliation conflicted; retry required");
        return "enrolled";
      }
      if (migrationClassification(doc, sub) !== "eligible") return "skipped";
      const recipient = await stripe.accounts.retrieve(row.accountId);
      if (recipient.capabilities?.transfers !== "active" || !recipient.payouts_enabled) return "skipped";
      const enrolledAt = timestamp();
      if (row.effectivePeriodStart <= enrolledAt + 3600) return "skipped";
      // A new attempt has a new idempotency key only when its request body has
      // a new enrolledAt. An ambiguous success is recognized on the re-read.
      const operationId = `${operationPrefix}${enrolledAt}`;
      const allocation = { version: 2, accountId: row.accountId, region: row.region,
        platformPercent: 20, livemode: true, effectivePeriodStart: row.effectivePeriodStart, enrolledAt };
      if (!validMemberRevenueAllocation(allocation)) throw new Error("Invalid migration allocation");
      const fields = memberRevenueMetadata(allocation, row.customerId, operationId);
      await assertOwned();
      const updated = await stripe.subscriptions.update(row.subscriptionId, { metadata: fields }, { idempotencyKey: operationId });
      assertPreserved(sub, updated);
      const parsed = readMemberRevenueAllocation(updated);
      if (parsed?.version !== 2 || parsed.effectivePeriodStart !== row.effectivePeriodStart) throw new Error("Stripe allocation verification failed");
      await assertOwned();
      const changed = await members.updateOne({ _id: row.memberId, subscription: doc.subscription,
        status: "active", region: row.region }, { $set: { "subscription.connected": true } });
      if (changed.matchedCount !== 1) throw new Error("Stripe enrolled but database reconciliation conflicted; manual retry required");
      const after = await stripe.subscriptions.retrieve(row.subscriptionId);
      assertPreserved(sub, after);
      const dbAfter = await members.findOne({ _id: row.memberId }, { projection: { subscription: 1 } });
      if (dbAfter?.subscription?.connected !== true) throw new Error("Database connected flag verification failed");
      return "enrolled";
    }); } catch (error) {
      await appendFile(auditPath, JSON.stringify({ at: new Date(), memberId: row.memberId, subscriptionId: row.subscriptionId,
        outcome: "error", code: error.code || "manual-review" }) + "\n", { mode: 0o600 });
      throw error;
    }
    result[outcome === "conflict" ? "conflicts" : outcome]++;
    await appendFile(auditPath, JSON.stringify({ at: new Date(), memberId: row.memberId, subscriptionId: row.subscriptionId, outcome }) + "\n", { mode: 0o600 });
  }
  return result;
}

async function main() {
  const args = new Map(process.argv.slice(2).map(arg => {
    if (!arg.startsWith("--")) throw new Error("Unexpected argument");
    const [key, ...value] = arg.slice(2).split("="); return [key, value.length ? value.join("=") : true];
  }));
  if ([...args.keys()].some(key => !["output", "pilot", "apply", "manifest", "approved-sha256", "backup", "audit"].includes(key))) throw new Error("Unknown argument");
  if (process.env.APP_ENV !== "prod") throw new Error("Production APP_ENV is required");
  mongoose.set("strictQuery", true);
  await mongoose.connect(mongoUri(), { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 15000 });
  try {
    const stripe = createStripeClient("netherlands");
    if (args.has("apply")) {
      if (!args.get("manifest") || !args.get("approved-sha256")) throw new Error("Apply needs manifest and approved hash");
      const manifest = JSON.parse(await readFile(args.get("manifest"), "utf8"));
      const result = await applyManifest({ manifest, approvedHash: args.get("approved-sha256"), backupPath: args.get("backup"),
        auditPath: args.get("audit"), stripe, members: MemberUser.collection });
      console.log(JSON.stringify({ mode: "apply", database: mongoose.connection.name, result }));
    } else {
      const full = await inventory({ stripe, members: MemberUser.collection, alumni: AlumniUser.collection });
      const manifest = args.has("pilot") ? pilotManifest(full) : full;
      if (args.get("output")) await writeFile(args.get("output"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ mode: "inventory", database: mongoose.connection.name, recipients: full.recipients,
        summary: full.summary, pilot: args.has("pilot") ? manifest.rows.map(row => ({ region: row.region, subscriptionId: row.subscriptionId })) : undefined,
        manifestSha256: args.get("output") ? hash(manifest) : undefined }));
    }
  } finally {
    try { await closeRedis(); } finally { await mongoose.disconnect(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async error => { console.error(`Existing-Member Connect migration failed: ${error.message}`); process.exitCode = 1; await mongoose.disconnect(); });
}
