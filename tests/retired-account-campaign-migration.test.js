import test from "node:test";
import assert from "node:assert/strict";
import migration from "../migrations/009-remove-retired-account-campaign-fields.js";

test("removes only retired account fields, preserves dismissal history and is idempotent", async (t) => {
  t.mock.method(console, "log", () => {});
  const fixture = [
    { _id: "both", campaigns: { release: { seenAt: new Date() } }, mmmCampaign2025: { calendarImage: "old.png" }, campaignsSeen: ["whats-new-version4"], name: "Test" },
    { _id: "campaigns-only", campaigns: null },
    { _id: "mmm-only", mmmCampaign2025: {} },
    { _id: "clean", campaignsSeen: [] },
  ];
  const collections = { memberUsers: structuredClone(fixture), alumniUsers: structuredClone(fixture) };
  const expected = [
    { _id: "both", campaignsSeen: ["whats-new-version4"], name: "Test" },
    { _id: "campaigns-only" },
    { _id: "mmm-only" },
    { _id: "clean", campaignsSeen: [] },
  ];
  const counts = [];
  const db = { collection(name) {
    assert.ok(Object.hasOwn(collections, name), "Only member/alumni accounts may be touched");
    return { async updateMany(filter, update) {
      assert.deepEqual(filter, { $or: [{ campaigns: { $exists: true } }, { mmmCampaign2025: { $exists: true } }] });
      assert.deepEqual(update, { $unset: { campaigns: "", mmmCampaign2025: "" } });
      let modifiedCount = 0;
      for (const doc of collections[name]) {
        if (!filter.$or.some(condition => Object.hasOwn(doc, Object.keys(condition)[0]))) continue;
        for (const field of Object.keys(update.$unset)) delete doc[field];
        modifiedCount++;
      }
      counts.push(modifiedCount);
      return { modifiedCount };
    } };
  } };
  await migration.up(db);
  assert.deepEqual(collections.memberUsers, expected);
  assert.deepEqual(collections.alumniUsers, expected);
  await migration.up(db);
  assert.deepEqual(counts, [3, 3, 0, 0]);
});

test("database failures stop the migration so the runner can roll back", async () => {
  await assert.rejects(migration.up({ collection: () => ({ updateMany: async () => { throw new Error("write failed"); } }) }), /write failed/);
});
