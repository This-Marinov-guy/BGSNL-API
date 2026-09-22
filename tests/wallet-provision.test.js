import test from "node:test";
import assert from "node:assert/strict";
import { ensureWalletRecord, automaticWalletCard } from "../services/wallet/provision.js";
import { backfillWalletCards } from "../scripts/backfill-wallet-cards.js";

function memoryRecords() {
  const saved = new Map();
  let collisions = 0;
  return {
    saved, collide: () => { collisions++; }, init: async () => {},
    findOne: async (query) => [...saved.values()].find((record) => query.$or.some((part) => part._id === record._id || part.accountId?.$in.includes(record.accountId))) || null,
    findOneAndUpdate: async (query, update) => {
      if (collisions) { collisions--; throw Object.assign(new Error("collision"), { code: 11000 }); }
      if (!saved.has(query._id)) saved.set(query._id, { _id: query._id, revokedAt: null, ...update.$setOnInsert });
      return saved.get(query._id);
    },
  };
}

test("automatic provisioning is stable, distinct, collision-safe and preserves revocations", async () => {
  const records = memoryRecords();
  records.collide();
  const member = await ensureWalletRecord({ _id: "member_one" }, records);
  assert.match(member.token, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(member.consentedAt, undefined);
  assert.equal(member.provisionedAutomatically, true);
  assert.equal((await ensureWalletRecord({ _id: "alumni_one", accountAliases: ["member_one"] }, records)).token, member.token);
  assert.notEqual((await ensureWalletRecord({ _id: "alumni_two" }, records)).token, member.token);
  member.revokedAt = new Date();
  assert.equal((await ensureWalletRecord({ _id: "member_one" }, records)).revokedAt, member.revokedAt);
  const results = await Promise.all(Array.from({ length: 10 }, () => ensureWalletRecord({ _id: "member_race" }, records)));
  assert.equal(new Set(results.map((record) => record.token)).size, 1);
  await assert.rejects(ensureWalletRecord({ _id: "admin_one" }, records));
});

test("migration is read-only by default and idempotent across members and alumni", async () => {
  const records = memoryRecords();
  const database = { collection: (name) => ({ find: () => name === "memberUsers"
    ? [{ _id: "member_one" }, { _id: "member_two" }]
    : [{ _id: "alumni_one", accountAliases: ["member_one"] }, { _id: "alumni_three" }] }) };
  const dry = await backfillWalletCards({ database, records });
  assert.equal(dry.scanned, 4); assert.equal(dry.provisioned, 0); assert.equal(records.saved.size, 0);
  const first = await backfillWalletCards({ database, records, apply: true });
  assert.equal(first.provisioned, 3);
  const tokens = [...records.saved.values()].map((record) => record.token);
  records.saved.get("one").revokedAt = new Date();
  const second = await backfillWalletCards({ database, records, apply: true });
  assert.equal(second.provisioned, 0); assert.equal(second.revoked, 2);
  assert.deepEqual([...records.saved.values()].map((record) => record.token), tokens);
});

test("new account saves provision a token before completing; failures propagate", async () => {
  const hooks = {};
  let count = 0;
  automaticWalletCard({ pre: (name, hook) => { hooks[name] = hook; } }, { provision: async () => { count++; } });
  await hooks.save.call({ isNew: true, _id: "member_new" });
  await hooks.save.call({ isNew: false, _id: "member_new" });
  assert.equal(count, 1);
  automaticWalletCard({ pre: (name, hook) => { hooks[name] = hook; } }, { provision: async () => { throw new Error("unavailable"); } });
  await assert.rejects(hooks.save.call({ isNew: true }), /unavailable/);
});
