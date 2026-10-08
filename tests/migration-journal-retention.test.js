import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { pruneMigrationJournal } from "../services/migrations/journal-retention.js";
import { runDailyCleanup } from "../services/background-services/event-draft-cleanup.js";

// eslint-disable-next-line no-process-env
const uri = process.env.BGSNL_MIGRATION_TEST_URL;
if (uri && !/^mongodb:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/.test(uri)) {
  throw new Error("Migration integration tests only accept a local MongoDB host without a database");
}

test("daily cleanup runs drafts and migration journal with the same clock", async () => {
  const now = new Date("2026-10-07T01:00:00Z");
  const calls = [];
  const result = await runDailyCleanup({ now,
    cleanDrafts: async args => { calls.push(["drafts", args.now]); return { deletedCount: 2 }; },
    cleanJournal: async args => { calls.push(["journal", args.now]); return { runsDeleted: 1 }; },
  });
  assert.deepEqual(calls, [["drafts", now], ["journal", now]]);
  assert.deepEqual(result, { drafts: { deletedCount: 2 }, migrationJournal: { runsDeleted: 1 } });
});

test("journal cleanup deletes only eligible completed runs and their snapshots", async () => {
  const now = new Date("2026-10-07T12:00:00Z");
  const cutoff = new Date("2026-09-07T12:00:00Z");
  const deleted = [];
  let query, closed = false;
  const candidates = [
    { _id: "run:successful", runId: "successful", status: "succeeded" },
    { _id: "run:restored", runId: "restored", status: "rolledBack" },
    { _id: "run:locked", runId: "locked", status: "rolledBack" },
    { _id: "bad-id", runId: "bad", status: "succeeded" },
  ];
  const journal = {
    findOne: async () => ({ _id: "lock:deployment", runId: "locked" }),
    find: filter => { query = filter; return {
      async *[Symbol.asyncIterator]() { yield* candidates; },
      close: async () => { closed = true; },
    }; },
    deleteMany: async filter => { deleted.push(["snapshots", filter.runId]); return { deletedCount: 3 }; },
    deleteOne: async filter => { deleted.push(["run", filter._id]); return { deletedCount: 1 }; },
  };
  const result = await pruneMigrationJournal({ now, db: { collection: name => {
    assert.equal(name, "migrationJournal"); return journal;
  } } });
  assert.deepEqual(query, { kind: "run", status: { $in: ["succeeded", "rolledBack"] }, $or: [
    { recoveredAt: { $type: "date", $lt: cutoff } },
    { recoveredAt: null, finishedAt: { $type: "date", $lt: cutoff } },
  ] });
  assert.deepEqual(deleted, [["snapshots", "successful"], ["run", "run:successful"],
    ["snapshots", "restored"], ["run", "run:restored"]]);
  assert.deepEqual(result, { runsDeleted: 2, snapshotsDeleted: 6, cutoff });
  assert(closed);
});

test("snapshot deletion failure retains the run record for a retry", async () => {
  let runDeleted = false, closed = false;
  const journal = {
    findOne: async () => null,
    find: () => ({ async *[Symbol.asyncIterator]() {
      yield { _id: "run:old", runId: "old", status: "rolledBack" };
    }, close: async () => { closed = true; } }),
    deleteMany: async () => { throw new Error("database unavailable"); },
    deleteOne: async () => { runDeleted = true; },
  };
  await assert.rejects(pruneMigrationJournal({ db: { collection: () => journal } }), /database unavailable/);
  assert.equal(runDeleted, false);
  assert(closed);
});

test("invalid time never touches the journal", async () => {
  await assert.rejects(pruneMigrationJournal({ now: "invalid", db: {
    collection: () => assert.fail("Must not access the journal"),
  } }), /Invalid migration journal cleanup time/);
});

test("MongoDB retention preserves unresolved, recent, locked and orphaned records", { skip: !uri }, async t => {
  const client = await new MongoClient(uri).connect();
  const db = client.db(`bgsnl_migration_test_${randomUUID().replaceAll("-", "")}`);
  t.after(async () => { await db.dropDatabase(); await client.close(); });
  const journal = db.collection("migrationJournal");
  const old = new Date("2026-09-01T00:00:00Z");
  const recent = new Date("2026-10-01T00:00:00Z");
  const boundary = new Date("2026-09-07T12:00:00Z");
  const runs = [
    { _id: "run:success", kind: "run", runId: "success", status: "succeeded", finishedAt: old },
    { _id: "run:rollback", kind: "run", runId: "rollback", status: "rolledBack", finishedAt: old },
    { _id: "run:recovered", kind: "run", runId: "recovered", status: "rolledBack", finishedAt: old, recoveredAt: recent },
    { _id: "run:failed", kind: "run", runId: "failed", status: "rollbackFailed", finishedAt: old },
    { _id: "run:running", kind: "run", runId: "running", status: "running", startedAt: old },
    { _id: "run:boundary", kind: "run", runId: "boundary", status: "succeeded", finishedAt: boundary },
    { _id: "run:locked", kind: "run", runId: "locked", status: "rolledBack", finishedAt: old },
  ];
  await journal.insertMany([
    { _id: "lock:deployment", kind: "lock", runId: "locked", startedAt: old },
    ...runs,
    ...["success", "rollback", "recovered", "failed", "running", "boundary", "locked", "orphan"]
      .map(runId => ({ _id: `snap:${runId}:0:0`, kind: "snapshot", runId, doc: { value: runId } })),
  ]);
  const result = await pruneMigrationJournal({ now: new Date("2026-10-07T12:00:00Z"), db });
  assert.equal(result.runsDeleted, 2);
  assert.equal(result.snapshotsDeleted, 2);
  const remaining = (await journal.find({}, { projection: { _id: 1 } }).toArray()).map(row => row._id);
  assert(!remaining.includes("run:success"));
  assert(!remaining.includes("snap:success:0:0"));
  assert(!remaining.includes("run:rollback"));
  assert(!remaining.includes("snap:rollback:0:0"));
  for (const id of ["lock:deployment", "run:recovered", "run:failed", "run:running", "run:boundary", "run:locked",
    "snap:recovered:0:0", "snap:failed:0:0", "snap:running:0:0", "snap:boundary:0:0", "snap:locked:0:0", "snap:orphan:0:0"]) {
    assert(remaining.includes(id), `${id} must remain`);
  }
});
