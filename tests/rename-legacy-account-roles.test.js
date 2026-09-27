import assert from "node:assert/strict";
import test from "node:test";
import migration from "../migrations/004-rename-legacy-account-roles.js";

test("renames legacy account roles and retains each resulting role once", async () => {
  const calls = [];
  const present = new Set(["memberUsers", "alumniUsers"]);
  const db = {
    listCollections({ name }) {
      return { toArray: async () => present.has(name) ? [{ name }] : [] };
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

  assert.equal(calls.length, 2);
  for (const { filter, update } of calls) {
    assert.deepEqual(filter, { roles: { $type: "array", $in: ["society_board_member", "board_member", "committee_member"] } });
    assert.equal(update[0].$set.roles.$reduce.initialValue.length, 0);
    const branches = update[0].$set.roles.$reduce.input.$map.in.$switch.branches;
    assert.deepEqual(branches.map(({ then }) => then), ["national_board_member", "regional_board_member", "regional_committee_member"]);
  }
});
