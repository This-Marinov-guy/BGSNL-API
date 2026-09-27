import test from "node:test";
import assert from "node:assert/strict";
import migration from "../migrations/010-simplify-support-statuses.js";

test("support status migration normalizes only retired statuses and is idempotent", async () => {
  const rows = ["open", "resolved", "rejected", "paused", "in_progress", "waiting_for_you", "closed"].map(status => ({ status, subject: "Unchanged" }));
  let modified = 0;
  const db = { collection(name) {
    assert.equal(name, "supportConversations");
    return { async updateMany(filter, update) {
      for (const row of rows) if (typeof filter.status === "string" ? row.status === filter.status : filter.status.$in.includes(row.status)) {
        Object.assign(row, update.$set); modified++;
      }
    } };
  } };
  await migration.up(db); await migration.up(db);
  assert.equal(modified, 3);
  assert.deepEqual(rows.map(row => row.status), ["open", "resolved", "rejected", "paused", "open", "open", "resolved"]);
  assert.ok(rows.every(row => row.subject === "Unchanged"));
});
