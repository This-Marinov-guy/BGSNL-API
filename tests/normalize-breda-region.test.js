import assert from "node:assert/strict";
import test from "node:test";
import migration from "../migrations/003-normalize-breda-region.js";

test("normalizes legacy Breda values in every application collection and known nested region fields", async () => {
  const calls = [];
  const db = {
    listCollections() {
      return { toArray: async () => [
        { name: "memberUsers" }, { name: "events" }, { name: "eventDrafts" },
        { name: "_migrations" }, { name: "system.views" },
      ] };
    },
    collection(name) {
      return {
        async updateMany(filter, update) {
          calls.push({ name, filter, update });
          return { modifiedCount: 1 };
        },
      };
    },
  };

  await migration.up(db);

  assert.equal(calls.length, 9);
  assert.deepEqual([...new Set(calls.map(({ name }) => name))], ["memberUsers", "events", "eventDrafts"]);
  assert.deepEqual(
    calls.map(({ filter }) => Object.keys(filter)[0]),
    ["region", "draftData.region", "draftOwner.region", "region", "draftData.region", "draftOwner.region", "region", "draftData.region", "draftOwner.region"],
  );
  for (const { filter, update } of calls) {
    const path = Object.keys(filter)[0];
    assert.deepEqual(filter[path], { $in: ["breda", "bread"] });
    assert.deepEqual(update, { $set: { [path]: "breda_tilburg" } });
  }
});
