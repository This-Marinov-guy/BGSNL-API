import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import MemberUser from "../models/MemberUser.js";
import AlumniUser from "../models/AlumniUser.js";
import { migrateAccountStorage, retiredCollections } from "../scripts/migrate-account-storage.js";
import { redisClient, closeRedis } from "../services/storage/redis.js";
import RefreshSession from "../models/RefreshSession.js";
import BillingRecord from "../models/BillingRecord.js";
import BillingAttention from "../models/BillingAttention.js";
import PaymentReturn from "../models/PaymentReturn.js";
import AuthChallenge from "../models/AuthChallenge.js";

const enabled = process.env.BGSNL_STORAGE_TEST_REDIS === "true" && !!process.env.BGSNL_STORAGE_TEST_MONGO;
test("migration preserves account data and live temporary state before dropping obsolete collections", { skip: !enabled, timeout: 60000 }, async (t) => {
  assert.match(process.env.BGSNL_STORAGE_TEST_MONGO, /^mongodb:\/\/127\.0\.0\.1:27028\/bgsnl_storage_test\?/);
  assert.equal(process.env.BGSNL_REDIS_URL, "redis://127.0.0.1:6389/15");
  process.env.BGSNL_REDIS_PREFIX = `bgsnl-migration-fixture:${randomUUID()}:`;
  await mongoose.connect(process.env.BGSNL_STORAGE_TEST_MONGO.replace("/bgsnl_storage_test?", "/bgsnl_storage_migration_test?"), { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db, client = await redisClient();
  const directory = await mkdtemp(join(tmpdir(), "bgsnl-storage-backup-test-"));
  t.after(async () => {
    for await (const keys of client.scanIterator({ MATCH: `${process.env.BGSNL_REDIS_PREFIX}*` })) if (keys.length) await client.del(keys);
    await closeRedis(); await mongoose.disconnect(); await rm(directory, { recursive: true, force: true });
  });
  assert.equal(db.databaseName, "bgsnl_storage_migration_test");
  await db.dropDatabase();
  const shared = { name: "Storage", surname: "Fixture", email: "migration@fixture.invalid", password: "original-password-hash", image: "fixture", expireDate: new Date("2099-01-01"), phone: "fixture", university: "fixture" };
  const member = await MemberUser.create({ ...shared, _id: "member_migration", status: "membership-migrated", birth: new Date("2000-01-01"), tickets: [{ event: "saved", image: "ticket" }] });
  const alumni = await AlumniUser.create({ ...shared, _id: "alumni_migration", status: "active", roles: ["alumni", "admin"] });
  await db.collection("accountmigrationarchives").insertOne({ originalMember: member.toObject(), originalAlumni: alumni.toObject() });
  await db.collection("accountidentities").insertOne({ _id: new mongoose.Types.ObjectId(), accountId: member.id, provider: "google", subject: "migration-subject", email: shared.email });
  await db.collection("passkeycredentials").insertOne({ _id: "migration-key", accountId: member.id, name: "Fixture", rpId: "localhost", userHandle: "unchanged", publicKey: Buffer.from([1, 2, 3]), counter: 5, revision: 2, deviceType: "multiDevice", backedUp: true });
  const expiresAt = new Date(Date.now() + 86400000);
  await db.collection("refreshsessions").insertOne({ _id: "refresh-fixture", accountId: member.id, tokenHash: "unchanged-hash", generation: 4, expiresAt });
  await db.collection("paymentreturns").insertOne({ _id: "return-fixture", kind: "ticket", stripeId: "cs_fixture", expiresAt });
  await db.collection("billingrecords").insertOne({ _id: "signup:fixture", data: { registration: { password: "pending-hash" }, sessionId: "cs_fixture" } });
  await db.collection("billingrecords").insertOne({ _id: "checkout-event:netherlands:cs_old", completedAt: new Date("2020-01-01") });
  await db.collection("billingattentions").insertOne({ _id: "resolved-old", resolvedAt: new Date("2020-01-01") });
  await db.collection("billingattentions").insertOne({ _id: "unresolved-old", startedAt: new Date("2020-01-01") });
  await db.collection("authchallenges").insertOne({ _id: "challenge-fixture", purpose: "login", nonce: "nonce", origin: "http://localhost:3000", proofHash: "proof", expiresAt });
  await db.collection("birthdayemaildeliveries").insertOne({ _id: "old-log" });
  await db.collection("temporaryCodes").insertOne({ userId: "legacy-fixture", code: "123456", life: 3 });
  const before = await migrateAccountStorage(db);
  assert.equal(before.archivesToRemove, 1);
  assert.equal(await db.collection("accountidentities").countDocuments(), 1);
  await assert.rejects(migrateAccountStorage(db, { apply: true }), /Stop all old API writers/);
  const backupPath = join(directory, "backup.ejsonl");
  const receipts = new Map();
  const options = { apply: true, writersStopped: true, backupPath, stripeFor: (region) => {
    assert.equal(region, "netherlands");
    return { checkout: { sessions: {
      update: async (id, data) => { receipts.set(id, data); },
      retrieve: async (id) => receipts.get(id),
    } } };
  } };
  await migrateAccountStorage(db, options);
  const expiryBeforeRerun = +(await BillingRecord.findById("signup:fixture")).expiresAt;
  const compatibility = await migrateAccountStorage(db, { ...options, backupPath: join(directory, "rerun.ejsonl"), dropLegacy: true, keepArchivedAccounts: true });
  assert.equal(compatibility.archivedAccountsRetained, 1);
  assert.ok(await MemberUser.findById(member.id));
  const afterCompatibility = (await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name);
  for (const name of retiredCollections) assert.equal(afterCompatibility.includes(name), false, name);
  await migrateAccountStorage(db, { ...options, backupPath: join(directory, "finish.ejsonl"), dropLegacy: true });
  assert.equal(+(await BillingRecord.findById("signup:fixture")).expiresAt, expiryBeforeRerun);
  assert.equal(await BillingAttention.findById("unresolved-old"), null);
  for await (const keys of client.scanIterator({ MATCH: `${process.env.BGSNL_REDIS_PREFIX}*` })) {
    for (const key of keys) assert.ok(await client.pTTL(key) > 0, key);
  }
  assert.equal(receipts.get("cs_old").metadata.bgsnlFulfilled, "1");
  assert.equal(await BillingRecord.findById("checkout-event:netherlands:cs_old"), null);
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  const current = await AlumniUser.findById(alumni.id).select("+identities +passkeys");
  assert.equal(current.password, shared.password);
  assert.deepEqual([...current.roles], ["alumni", "admin"]);
  assert.equal(current.birth.toISOString(), "2000-01-01T00:00:00.000Z");
  assert.equal(current.tickets.length, 1);
  assert.ok(current.accountAliases.includes(member.id));
  assert.equal(current.identities[0].subject, "migration-subject");
  assert.equal(current.passkeys[0].counter, 5);
  assert.equal(current.passkeys[0].userHandle, "unchanged");
  assert.equal(await MemberUser.findById(member.id), null);
  assert.equal((await RefreshSession.findById("refresh-fixture")).tokenHash, "unchanged-hash");
  assert.equal((await PaymentReturn.findById("return-fixture")).stripeId, "cs_fixture");
  assert.equal((await BillingRecord.findById("signup:fixture")).data.registration.password, "pending-hash");
  assert.equal((await AuthChallenge.findById("challenge-fixture")).proofHash, "proof");
  assert.ok((await db.collection("temporaryCodes").findOne({ userId: "legacy-fixture" })).expiresAt);
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name);
  for (const name of retiredCollections) assert.equal(names.includes(name), false, name);
  assert.ok((await db.collection("temporaryCodes").indexes()).some((index) => index.expireAfterSeconds === 0));
});
