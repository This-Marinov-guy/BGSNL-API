import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { redisClient, closeRedis } from "../services/storage/redis.js";
import { redisRecordStore } from "../services/storage/redis-records.js";
import { redisRateLimits } from "../services/storage/rate-limits.js";
import { redisCache } from "../services/storage/cache.js";
import { createSessionService } from "../services/authentication/sessions.js";
import { withBillingLease } from "../services/subscriptions/lease.js";
import BillingRecord from "../models/BillingRecord.js";
import BillingAttention from "../models/BillingAttention.js";
import { DAY_MS } from "../services/storage/retention.js";

const enabled = process.env.BGSNL_STORAGE_TEST_REDIS === "true";
test("Redis TTLs, atomic updates, rotating sessions and cache isolation", { skip: !enabled, timeout: 30000 }, async (t) => {
  assert.match(process.env.BGSNL_REDIS_URL || "", /^redis:\/\/127\.0\.0\.1:(?:6380|6389)\/15$/);
  process.env.BGSNL_REDIS_PREFIX = `bgsnl-fixture:${randomUUID()}:`;
  process.env.JWT_STRING = "storage-fixture-signing-secret-only";
  const client = await redisClient();
  t.after(async () => {
    for await (const keys of client.scanIterator({ MATCH: `${process.env.BGSNL_REDIS_PREFIX}*` })) if (keys.length) await client.del(keys);
    await closeRedis();
  });
  const records = redisRecordStore("fixture");
  await t.test("parallel compare-and-set increments lose no updates", async () => {
    await records.create({ _id: "counter", count: 0, expiresAt: new Date(Date.now() + 60000) });
    await Promise.all(Array.from({ length: 12 }, () => records.updateOne({ _id: "counter" }, { $inc: { count: 1 } })));
    assert.equal((await records.findById("counter")).count, 12);
    const before = await records.findById("counter");
    assert.equal((await records.findById("counter")).expiresAt.getTime(), before.expiresAt.getTime());
    await assert.rejects(records.updateOne({ _id: "counter", count: 0 }, { $set: { count: 99 } }, { upsert: true }), { code: 11000 });
    const results = await Promise.all([records.findOneAndDelete({ _id: "counter" }), records.findOneAndDelete({ _id: "counter" })]);
    assert.equal(results.filter(Boolean).length, 1);
  });
  await t.test("records expire in Redis and reads do not renew them", async () => {
    await records.create({ _id: "expiry", expiresAt: new Date(Date.now() + 250) });
    assert.ok(await records.findById("expiry"));
    await delay(300);
    assert.equal(await records.findById("expiry"), null);
    await assert.rejects(records.create({ _id: "already-expired", expiresAt: new Date(0) }), /expired/);
  });
  await t.test("missing and invalid expiry cannot create permanent keys or strip an existing TTL", async () => {
    await assert.rejects(records.create({ _id: "no-expiry" }), /finite Redis expiry/);
    await assert.rejects(records.create({ _id: "bad-expiry", expiresAt: "invalid" }), /finite Redis expiry/);
    await assert.rejects(records.updateOne({ _id: "no-expiry" }, { $set: { value: 1 } }, { upsert: true }), /finite Redis expiry/);
    await records.create({ _id: "protected-expiry", expiresAt: new Date(Date.now() + 60000) });
    await assert.rejects(records.updateOne({ _id: "protected-expiry" }, { $unset: { expiresAt: 1 } }), /finite Redis expiry/);
    assert.ok((await records.findById("protected-expiry")).expiresAt);
    assert.equal(await records.findById("no-expiry"), null);
  });
  await t.test("unfinished checkouts and unresolved reminders expire despite retries and polling", async () => {
    const startedAt = new Date(Date.now() - 30 * DAY_MS + 1500);
    await BillingRecord.create({ _id: "pending-expiry", data: { reservedAt: startedAt, registration: { password: "fixture-hash" } } });
    await BillingAttention.create({ _id: "reminder-expiry", startedAt });
    const checkout = await BillingRecord.findById("pending-expiry");
    const reminder = await BillingAttention.findById("reminder-expiry");
    await BillingRecord.updateOne({ _id: "pending-expiry" }, { $set: { updatedAt: new Date() } });
    await BillingAttention.updateOne({ _id: "reminder-expiry" }, { $set: { nextAttemptAt: new Date() } });
    assert.equal(+(await BillingRecord.findById("pending-expiry")).expiresAt, +checkout.expiresAt);
    assert.equal(+(await BillingAttention.findById("reminder-expiry")).expiresAt, +reminder.expiresAt);
    await delay(1550);
    assert.equal(await BillingRecord.findById("pending-expiry"), null);
    assert.equal(await BillingAttention.findById("reminder-expiry"), null);
  });
  await t.test("rate-limit increments and expiry are atomic across concurrent callers", async () => {
    const expiresAt = new Date(Date.now() + 60000);
    const results = await Promise.all(Array.from({ length: 20 }, () => redisRateLimits.findOneAndUpdate({ _id: "rate-fixture" }, { $inc: { count: 1 }, $setOnInsert: { expiresAt } })));
    assert.deepEqual(results.map((item) => item.count).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
    const remaining = await client.pTTL(`${process.env.BGSNL_REDIS_PREFIX}limit:rate-fixture`);
    assert.ok(remaining > 0 && remaining <= 60000);
  });
  await t.test("refresh rotation, concurrent refresh and logout work without a Mongo session collection", async () => {
    const user = { id: "member_fixture", roles: ["member"], sessionVersion: 0, status: "active" };
    const service = createSessionService({ records: redisRecordStore("refresh-fixture"), findAccount: async () => user });
    const initial = await service.start(user);
    const results = await Promise.all(Array.from({ length: 8 }, () => service.refresh(initial.refreshToken)));
    assert.equal(new Set(results.map((item) => item.refreshToken)).size, 1);
    assert.notEqual(results[0].refreshToken, initial.refreshToken);
    await service.revoke(results[0].refreshToken);
    await assert.rejects(service.refresh(results[0].refreshToken), { statusCode: 401 });
  });
  await t.test("scan queries retain dates, sorting and limits for pending checkout recovery", async () => {
    for (let i = 0; i < 3; i++) await records.create({ _id: `checkout-${i}`, data: { sessionId: `cs_${i}` }, order: i, expiresAt: new Date(Date.now() + 60000) });
    const pending = await records.find({ "data.sessionId": { $exists: true }, completedAt: null }).sort({ order: -1 }).limit(2);
    assert.deepEqual(pending.map((item) => item._id), ["checkout-2", "checkout-1"]);
    assert.equal(await records.countDocuments({ _id: /^checkout-/ }), 3);
  });
  await t.test("Redis lease takeover cannot be released by the old worker", async () => {
    const fences = { updateOne: async () => ({ matchedCount: 1 }) };
    const leaseRecords = { findById: async () => null };
    let finish, started;
    const ready = new Promise((resolve) => { started = resolve; }), gate = new Promise((resolve) => { finish = resolve; });
    const first = withBillingLease("fixture", async ({ assertOwned }) => { started(); await gate; await assertOwned(); }, { records: leaseRecords, fences });
    await ready;
    await assert.rejects(withBillingLease("fixture", async () => {}, { records: leaseRecords, fences }), { statusCode: 409 });
    let lock;
    for await (const keys of client.scanIterator({ MATCH: `${process.env.BGSNL_REDIS_PREFIX}lease:*` })) lock = keys[0];
    await client.set(lock, "new-owner", { PX: 60000 });
    finish(); await assert.rejects(first, /lease lost/);
    assert.equal(await client.get(lock), "new-owner");
  });
  await t.test("public caches preserve false/zero values and use a separate Redis namespace", async () => {
    assert.throws(() => redisCache("invalid"), /finite cache lifetime/);
    const cache = redisCache("counts", 60);
    await cache.set("total", 0); assert.equal(await cache.get("total"), 0);
    await cache.set("invalid", 1, null);
    assert.equal(await cache.get("invalid"), undefined);
    assert.equal(await cache.get("missing"), undefined);
  });
  await t.test("every remaining application key has a positive Redis TTL", async () => {
    for await (const keys of client.scanIterator({ MATCH: `${process.env.BGSNL_REDIS_PREFIX}*` })) {
      for (const key of keys) assert.ok(await client.pTTL(key) > 0, key);
    }
  });
});
