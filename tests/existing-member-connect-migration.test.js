import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMBER_REVENUE_ACCOUNTS, MEMBER_REVENUE_PLATFORM } from "../util/config/member-revenue.js";
import { MEMBERSHIP_PLANS } from "../util/subscriptions/policy.js";
import { applyManifest, billingSnapshot, migrationClassification, pilotManifest } from "../scripts/migrate-existing-member-connect.js";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const priceId = MEMBERSHIP_PLANS.find(plan => plan.type === "member").priceId;
const future = Math.floor(Date.now() / 1000) + 30 * 86400;
const subscription = () => ({ id: "sub_migration", customer: "cus_migration", livemode: true, status: "active",
  current_period_start: future - 30 * 86400, current_period_end: future, billing_cycle_anchor: future - 30 * 86400,
  collection_method: "charge_automatically", items: { data: [{ id: "si_migration", price: { id: priceId }, quantity: 1 }] },
  metadata: { unrelated: "preserve-me" } });
const member = () => ({ _id: "member_one", status: "active", roles: ["member"], region: "amsterdam",
  subscription: { id: "sub_migration", customerId: "cus_migration", stripeRegion: "netherlands", priceId,
    status: "active", connected: false } });
const lease = async (_key, work) => work({ assertOwned: async () => {} });

test("only current, centrally billed Member subscriptions are eligible", () => {
  const doc = member(); const sub = subscription();
  assert.equal(migrationClassification(doc, sub), "eligible");
  assert.equal(migrationClassification({ ...doc, status: "locked" }, sub), "not-current-member");
  assert.equal(migrationClassification({ ...doc, region: "eindhoven" }, sub), "unsupported-region");
  assert.equal(migrationClassification({ ...doc, subscription: { ...doc.subscription, stripeRegion: "groningen" } }, sub), "legacy-regional-billing");
  assert.equal(migrationClassification(doc, { ...sub, cancel_at_period_end: true }), "subscription-state-review");
  assert.equal(migrationClassification(doc, { ...sub, customer: "cus_other" }), "ownership-mismatch");
});

test("pilot selects one eligible subscription per region with a renewal at least a week away", () => {
  const input = { createdAt: new Date().toISOString(), rows: [
    { classification: "eligible", region: "amsterdam", subscriptionId: "imminent", effectivePeriodStart: future - 28 * 86400 },
    { classification: "eligible", region: "amsterdam", subscriptionId: "near", effectivePeriodStart: future },
    { classification: "eligible", region: "amsterdam", subscriptionId: "far", effectivePeriodStart: future + 86400 },
    { classification: "eligible", region: "groningen", subscriptionId: "other", effectivePeriodStart: future },
  ] };
  assert.deepEqual(pilotManifest(input).rows.map(row => row.subscriptionId), ["near", "other"]);
});

test("a Stripe-success, database-failure retry only reconciles the original allocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bgsnl-connect-migration-test-"));
  let sub = subscription(); let doc = member(); let stripeUpdates = 0; let failDatabase = true;
  const stripe = { accounts: { retrieve: async id => ({ id: id || MEMBER_REVENUE_PLATFORM,
    capabilities: { transfers: "active" }, payouts_enabled: true }) },
  balance: { retrieve: async () => ({ livemode: true }) }, subscriptions: {
    retrieve: async () => structuredClone(sub),
    update: async (_id, body) => { stripeUpdates++; sub = { ...sub, metadata: { ...sub.metadata, ...body.metadata } }; return structuredClone(sub); },
  } };
  const members = { findOne: async () => structuredClone(doc),
    updateOne: async () => { if (failDatabase) { failDatabase = false; throw new Error("simulated database outage"); }
      doc = { ...doc, subscription: { ...doc.subscription, connected: true } }; return { matchedCount: 1 }; } };
  const row = { memberId: doc._id, region: doc.region, subscriptionId: sub.id, customerId: doc.subscription.customerId,
    classification: "eligible", accountId: MEMBER_REVENUE_ACCOUNTS.amsterdam, effectivePeriodStart: future,
    dbSubscription: structuredClone(doc.subscription), stripeSnapshot: billingSnapshot(sub), metadata: structuredClone(sub.metadata) };
  row.baselineHash = hash({ dbSubscription: row.dbSubscription, stripeSnapshot: row.stripeSnapshot, metadata: row.metadata });
  const manifest = { version: 1, createdAt: new Date().toISOString(), platformAccount: MEMBER_REVENUE_PLATFORM,
    database: "production-test", rows: [row] };
  const approvedHash = hash(manifest);
  const args = { manifest, approvedHash, stripe, members, databaseName: "production-test", withLease: lease };
  try {
    await assert.rejects(applyManifest({ ...args, backupPath: join(dir, "backup-1.json"), auditPath: join(dir, "audit-1.jsonl") }), /database outage/);
    assert.equal(doc.subscription.connected, false);
    assert.equal(stripeUpdates, 1);
    const backup = JSON.parse(await readFile(join(dir, "backup-1.json"), "utf8"));
    assert.equal(backup.rows[0].metadata.unrelated, "preserve-me");
    const result = await applyManifest({ ...args, backupPath: join(dir, "backup-2.json"), auditPath: join(dir, "audit-2.jsonl") });
    assert.equal(result.enrolled, 1);
    assert.equal(doc.subscription.connected, true);
    assert.equal(stripeUpdates, 1);
    assert.equal(sub.metadata.unrelated, "preserve-me");
    const repeated = await applyManifest({ ...args, backupPath: join(dir, "backup-3.json"), auditPath: join(dir, "audit-3.jsonl") });
    assert.equal(repeated.alreadyEnrolled, 1);
    assert.equal(stripeUpdates, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
