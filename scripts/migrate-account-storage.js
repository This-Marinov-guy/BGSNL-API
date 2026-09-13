import "dotenv/config";
import mongoose from "mongoose";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EJSON } from "bson";
import { planAccountStorage } from "../services/storage/migration-plan.js";
import { redisClient, closeRedis, redisPrefix } from "../services/storage/redis.js";
import RefreshSession from "../models/RefreshSession.js";
import PaymentReturn from "../models/PaymentReturn.js";
import BillingRecord from "../models/BillingRecord.js";
import BillingAttention from "../models/BillingAttention.js";
import AuthChallenge from "../models/AuthChallenge.js";
import PasswordResetChallenge from "../models/PasswordResetChallenge.js";
import ProfileChange from "../models/ProfileChange.js";
import TemporaryCode from "../models/TemporaryCode.js";
import User from "../models/User.js";
import AlumniUser from "../models/AlumniUser.js";
import { createStripeClient } from "../util/config/stripe.js";
import { memberRevenueMetadata, readMemberRevenueAllocation } from "../services/subscriptions/stripe-revenue-state.js";
import { reminderDeadline } from "../services/storage/retention.js";

export const retiredCollections = ["accountidentities", "passkeycredentials", "passkeychallenges", "authchallenges", "authratelimits", "passwordresetchallenges", "profilechanges", "refreshsessions", "paymentreturns", "billingrecords", "billingattentions", "memberrevenueshares", "birthdayemaildeliveries", "weeklymembershipreportdeliveries", "eventannouncementdeliveries", "accountmigrationarchives"];
const future = (row) => row.expiresAt && +new Date(row.expiresAt) > Date.now();
const readRows = (db, name) => db.collection(name).find({}).toArray();

export async function migrateAccountStorage(db, { apply = false, dropLegacy = false, writersStopped = false, backupPath, keepArchivedAccounts = false,
  stores = { refreshsessions: RefreshSession, paymentreturns: PaymentReturn, billingrecords: BillingRecord, billingattentions: BillingAttention },
  redisFor = redisClient, stripeFor = createStripeClient } = {}) {
  if (apply && (!writersStopped || !backupPath)) throw new Error("Stop all old API writers and provide --writers-stopped --backup=<path> before applying");
  if (dropLegacy && !apply) throw new Error("--drop-legacy requires --apply");
  const names = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name));
  const rows = {};
  for (const name of [...retiredCollections, "users", "alumniusers", "temporarycodes"]) rows[name] = names.has(name) ? await readRows(db, name) : [];
  const plan = planAccountStorage({ members: rows.users, alumni: rows.alumniusers, archives: rows.accountmigrationarchives, identities: rows.accountidentities, passkeys: rows.passkeycredentials });
  const summary = { mode: apply ? "apply" : "dry-run", database: db.databaseName,
    collections: Object.fromEntries(retiredCollections.map((name) => [name, rows[name].length])), accountsToUpdate: plan.changes.length, archivesToRemove: plan.archived.length };
  if (!apply) return summary;
  // Credentials and originals never go to stdout. Exclusive file creation
  // prevents overwriting the only rollback copy on a rerun.
  const backup = await open(backupPath, "wx", 0o600);
  try {
    await backup.write(`${EJSON.stringify({ format: "bgsnl-storage-v1", database: db.databaseName, createdAt: new Date() })}\n`);
    for (const [collection, documents] of Object.entries(rows)) for (const document of documents) await backup.write(`${EJSON.stringify({ collection, document })}\n`);
    await backup.sync();
  } finally { await backup.close(); }
  const redis = await redisFor();
  await redis.ping();
  // Completed webhook receipts outlive Redis's retention window on Stripe.
  for (const record of rows.billingrecords.filter((row) => row.completedAt && String(row._id).startsWith("checkout-event:"))) {
    const [, region, sessionId] = record._id.split(":");
    if (!region || !sessionId) throw new Error("Invalid legacy checkout receipt");
    const stripe = stripeFor(region);
    await stripe.checkout.sessions.update(sessionId, { metadata: { bgsnlFulfilled: "1" } });
    if ((await stripe.checkout.sessions.retrieve(sessionId)).metadata?.bgsnlFulfilled !== "1") throw new Error("Stripe checkout receipt export verification failed");
  }
  // Stripe financial history stays on Stripe. Export the old enrollment proof
  // and any unfinished transfer before its local ledger can be retired.
  for (const record of rows.billingrecords.filter((row) => String(row._id).startsWith("member-revenue-subscription:"))) {
    const data = record.data;
    const stripe = stripeFor("netherlands"), sub = await stripe.subscriptions.retrieve(data.subscriptionId);
    if ((typeof sub.customer === "string" ? sub.customer : sub.customer?.id) !== data.customerId || sub.livemode !== data.livemode) throw new Error("Legacy regional subscription ownership mismatch");
    const current = readMemberRevenueAllocation(sub);
    if (current && current.accountId !== data.accountId) throw new Error("Conflicting Stripe regional allocation");
    if (!current) await stripe.subscriptions.update(sub.id, { metadata: memberRevenueMetadata(data, data.customerId, sub.metadata?.bgsnlRevenueOperation || `migration-${sub.id}`) });
    const checked = readMemberRevenueAllocation(await stripe.subscriptions.retrieve(sub.id));
    if (checked?.accountId !== data.accountId) throw new Error("Stripe allocation export verification failed");
  }
  for (const share of rows.memberrevenueshares.filter((row) => row.operation)) {
    if (!share.invoiceId) throw new Error("Unfinished regional operation has no Stripe invoice");
    const stripe = stripeFor("netherlands"), invoice = await stripe.invoices.retrieve(share.invoiceId);
    const serialized = JSON.stringify(share.operation);
    if (invoice.metadata?.bgsnlPendingRevenueOperation && invoice.metadata.bgsnlPendingRevenueOperation !== serialized) throw new Error("Conflicting Stripe revenue operation");
    await stripe.invoices.update(invoice.id, { metadata: { bgsnlPendingRevenueOperation: serialized } });
    if ((await stripe.invoices.retrieve(invoice.id)).metadata?.bgsnlPendingRevenueOperation !== serialized) throw new Error("Stripe operation export verification failed");
  }
  for (const [name, store] of Object.entries(stores)) {
    for (const original of rows[name]) {
      if (["refreshsessions", "paymentreturns"].includes(name) && !future(original)) continue;
      if (name === "billingrecords" && /^(member-revenue-|portal-config:)/.test(original._id)) continue;
      if (name === "billingrecords" && original.completedAt && +new Date(original.completedAt) + 30 * 86400000 <= Date.now()) continue;
      if (name === "billingrecords" && !original.data && !original.completedAt) continue;
      if (name === "billingattentions" && reminderDeadline(original) <= Date.now()) continue;
      const record = { ...original }; delete record.__v; delete record.owner; delete record.leaseUntil;
      const existing = await store.findById(String(record._id));
      // Legacy pending registrations get one 30-day recovery window at cutover.
      // A rerun preserves its original deadline, including after partial failure.
      if (name === "billingrecords" && !record.completedAt) record.data = { ...record.data,
        reservedAt: record.data?.reservedAt || existing?.data?.reservedAt || new Date() };
      if (existing) {
        for (const key of Object.keys(record)) if (!(key === "expiresAt" && !original.expiresAt) && EJSON.stringify(existing[key]) !== EJSON.stringify(record[key])) throw new Error(`Conflicting Redis ${name}; refusing to overwrite current state`);
      } else await store.create(record);
      if (!await store.findById(String(record._id))) throw new Error("Redis migration verification failed");
    }
  }
  for (const row of rows.authratelimits.filter(future)) {
    const key = `${redisPrefix()}limit:${row._id}`;
    const existing = Number(await redis.get(key) || 0);
    await redis.set(key, String(Math.max(existing, row.count || 0)), { PX: Math.max(1, +new Date(row.expiresAt) - Date.now()) });
  }
  for (const [name, store, defaults] of [["authchallenges", AuthChallenge, { kind: "google" }], ["passkeychallenges", AuthChallenge, { kind: "passkey" }], ["passwordresetchallenges", PasswordResetChallenge, {}], ["profilechanges", ProfileChange, {}]]) {
    for (const row of rows[name].filter(future)) {
      const record = { ...row, ...defaults }; delete record.__v;
      const existing = await store.findById(String(row._id));
      if (existing) {
        if (existing.proofHash !== row.proofHash || existing.generation !== row.generation) throw new Error("Conflicting temporary challenge");
      } else await store.create(record);
      if (!await store.findById(String(row._id))) throw new Error("Temporary challenge migration verification failed");
    }
  }
  for (const change of plan.changes) {
    const fields = {};
    for (const key of Object.keys(change.next)) if (EJSON.stringify(change.next[key]) !== EJSON.stringify(change.original[key])) fields[key] = change.next[key];
    const result = await db.collection(change.collection).updateOne(change.original, { $set: fields });
    if (result.matchedCount !== 1) throw new Error("Account changed during migration; no collections were dropped");
    const saved = await db.collection(change.collection).findOne({ _id: change.original._id });
    for (const key of Object.keys(fields)) if (EJSON.stringify(saved[key]) !== EJSON.stringify(fields[key])) throw new Error("Embedded account verification failed");
  }
  for (const Model of [User, AlumniUser]) await Model.createIndexes();
  for (const store of [TemporaryCode, AuthChallenge, PasswordResetChallenge, ProfileChange]) await store.init();
  await db.collection("temporarycodes").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  // Legacy numeric codes had no TTL. Retain a short cutover grace period only.
  await db.collection("temporarycodes").updateMany({ expiresAt: { $exists: false }, code: { $exists: true } }, { $set: { expiresAt: new Date(Date.now() + 15 * 60000) } });
  if (dropLegacy) {
    for (const { collection, doc } of keepArchivedAccounts ? [] : plan.archived) {
      const result = await db.collection(collection).deleteOne(doc);
      if (result.deletedCount !== 1) throw new Error("Archived profile changed; stop and inspect the backup");
    }
    for (const name of retiredCollections) if (names.has(name)) await db.collection(name).drop();
  }
  return { ...summary, migrated: true, dropped: dropLegacy, archivedAccountsRetained: keepArchivedAccounts ? plan.archived.length : 0 };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--apply", "--drop-legacy", "--writers-stopped", "--keep-archived-accounts"].includes(arg) && !arg.startsWith("--backup=") && !arg.startsWith("--database="))) throw new Error("Unknown argument");
  const database = args.find((arg) => arg.startsWith("--database="))?.slice(11);
  if (!database) throw new Error("Pass the exact target --database=<name>; the application default is never assumed");
  mongoose.set("strictQuery", true);
  await mongoose.connect(`mongodb+srv://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASS)}@${process.env.DB}`, { dbName: database, autoIndex: false, autoCreate: false });
  try {
    console.log(JSON.stringify(await migrateAccountStorage(mongoose.connection.db, { apply: args.includes("--apply"), dropLegacy: args.includes("--drop-legacy"), writersStopped: args.includes("--writers-stopped"), keepArchivedAccounts: args.includes("--keep-archived-accounts"), backupPath: args.find((arg) => arg.startsWith("--backup="))?.slice(9) })));
  } finally { await closeRedis(); await mongoose.disconnect(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(async () => {
  console.error("Storage migration stopped. Keep the backup and legacy collections; check configuration and resolve conflicts before retrying.");
  process.exitCode = 1; await closeRedis(); await mongoose.disconnect();
});
