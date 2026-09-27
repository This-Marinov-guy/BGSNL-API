import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MongoClient, BSON } from "mongodb";
import { runMigrations, recoverMigrationRun, internalCollection, safeError, RUNS, LOCKS, TRACKING } from "../services/migrations/runner.js";
import one from "../migrations/001-rename-users-to-member-users.js";
import two from "../migrations/002-camelcase-collection-names.js";
import three from "../migrations/003-normalize-breda-region.js";
import four from "../migrations/004-rename-legacy-account-roles.js";
import five from "../migrations/005-remove-event-backgrounds.js";
import six from "../migrations/006-region-event-slugs.js";
import seven from "../migrations/007-upgrade-production-events.js";

// Explicit opt-in, loopback only, and a fresh random database per test.
// eslint-disable-next-line no-process-env
const uri = process.env.BGSNL_MIGRATION_TEST_URL;
if (uri && !/^mongodb:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/.test(uri)) throw new Error("Migration integration tests only accept a local MongoDB host without a database");
const migrations = [one, two, three, four, five, six, seven];
const options = { writersStopped: true, log: () => {} };

async function setup(t) {
  const client = await new MongoClient(uri).connect();
  const db = client.db(`bgsnl_migration_test_${randomUUID().replaceAll("-", "")}`);
  t.after(async () => { await db.dropDatabase(); await client.close(); });
  return db;
}

async function seed(db) {
  await db.createCollection("users", { validator: { $jsonSchema: { bsonType: "object", required: ["email"] } }, validationLevel: "moderate" });
  await db.collection("users").insertOne({ _id: "member_1", email: "member@example.test", region: "bread", roles: ["board_member", "member"] });
  await db.collection("users").createIndex({ email: 1 }, { unique: true, name: "member_email" });
  await db.createCollection("memberUsers"); // Legacy empty placeholder must also return on rollback.
  await db.collection("memberUsers").createIndex({ region: 1 }, { name: "empty_region_index" });
  await db.collection("alumniusers").insertOne({ _id: "alumni_1", region: "breda", roles: ["committee_member"] });
  await db.collection("events").insertOne({ _id: "event_1", title: "Welcome", status: "opened", region: "breda", date: new Date("2099-09-22T17:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z"),
    bgImage: 1, lastUpdate: { id: "editor", timestamp: new Date("2026-09-01T00:00:00Z") }, product: null, guestList: [{ ticket: "preserve" }],
    earlyBird: { isEnabled: false, ticketTimer: "" }, lateBird: { isEnabled: false, startTimer: "" } });
  await db.collection("events").createIndex({ slug: 1 }, { name: "old_global_slug", unique: true, partialFilterExpression: { slug: { $type: "string" } } });
  await db.collection(TRACKING).insertOne({ _id: "000-prior", appliedAt: new Date("2026-01-01T00:00:00Z") });
}

async function state(db) {
  const result = {};
  for (const entry of (await db.listCollections().toArray()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (internalCollection(entry.name)) continue;
    result[entry.name] = { options: entry.options,
      docs: await db.collection(entry.name).find({}, { promoteValues: false }).sort({ _id: 1 }).toArray(),
      indexes: (await db.collection(entry.name).indexes()).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  return BSON.EJSON.stringify(result, { relaxed: false });
}

test("errors retain diagnostics but redact database URIs, secrets and duplicate key values", () => {
  const error = new Error('failed mongodb+srv://user:pass@host/db password=secret dup key: { email: "private@example.test" }');
  error.code = 11000;
  const safe = safeError(error, ["secret"]);
  assert.equal(safe.code, "11000");
  assert.match(safe.message, /failed/);
  assert.doesNotMatch(JSON.stringify(safe), /private@example|user:pass|password=secret/);
  assert.match(safe.stack, /Error:/);
});

test("CLI startup failure removes an old rollback confirmation before validation", async t => {
  const output = await mkdtemp(path.join(tmpdir(), "bgsnl-migration-cli-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  await writeFile(path.join(output, "rollback.status"), "rolled-back\n");
  await writeFile(path.join(output, "result.json"), '{"safeToResume":true}');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["migrations/run.js"], {
      // Missing --writers-stopped fails before any DB connection.
      // eslint-disable-next-line no-process-env
      env: { ...process.env, MIGRATION_OUTPUT_DIR: output }, stdio: "ignore",
    });
    child.on("error", reject); child.on("close", resolve);
  });
  assert.equal(code, 1);
  assert.deepEqual(await readdir(output), []);
});

test("rollback preserves exact BSON types and compound text indexes", { skip: !uri }, async t => {
  const db = await setup(t);
  await db.collection("typed").insertOne({ _id: "types", region: "a", title: "Text", amount: new BSON.Double(1),
    count: BSON.Long.fromNumber(2), binary: new BSON.Binary(Buffer.from([1, 2, 3])), decimal: BSON.Decimal128.fromString("3.40"),
    nested: [new BSON.Int32(4), BSON.Long.fromString("9007199254740993")] });
  await db.collection("typed").createIndex({ region: 1, title: "text" }, { name: "search", weights: { title: 5 } });
  const before = await state(db);
  await assert.rejects(runMigrations(db, [{ id: "typed-failure", async up(scoped) {
    await scoped.collection("typed").deleteMany({});
    throw new Error("Restore typed fields and text index");
  } }], options), error => error.result.safeToResume);
  assert.equal(await state(db), before);
});

test("parallel writes to distinct collections are journaled before failure and restored", { skip: !uri }, async t => {
  const db = await setup(t);
  await db.collection("first").insertOne({ _id: 1, value: "original" });
  await db.collection("second").insertOne({ _id: 2, value: "original" });
  const before = await state(db);
  await assert.rejects(runMigrations(db, [{ id: "parallel-failure", async up(scoped) {
    await Promise.all([
      scoped.collection("first").updateMany({}, { $set: { value: "changed" } }),
      scoped.collection("second").updateMany({}, { $set: { value: "changed" } }),
    ]);
    throw new Error("Rollback concurrent writes");
  } }], options), error => error.result.safeToResume);
  assert.equal(await state(db), before);
});

test("CLI exits nonzero on failure with a rollback marker; a successful retry clears the marker", { skip: !uri }, async t => {
  const db = await setup(t); await seed(db);
  // Migration 006 fails after preceding migrations have already changed data.
  await db.collection("events").dropIndex("old_global_slug");
  await db.collection("events").updateOne({ _id: "event_1" }, { $set: { slug: "duplicate" } });
  await db.collection("events").insertOne({ _id: "event_2", title: "Other", region: "breda", slug: "duplicate", status: "opened", date: new Date("2099-09-22") });
  const before = await state(db);
  const output = await mkdtemp(path.join(tmpdir(), "bgsnl-migration-cli-db-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const invoke = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["migrations/run.js", "--writers-stopped"], {
      // eslint-disable-next-line no-process-env
      env: { ...process.env, MIGRATION_MONGO_URI: `${uri.replace(/\/$/, "")}/${db.databaseName}`,
        MIGRATION_OUTPUT_DIR: output, DEPLOY_REVISION: "test-revision" }, stdio: "ignore",
    });
    child.on("error", reject); child.on("close", resolve);
  });
  assert.equal(await invoke(), 1);
  assert.equal(await state(db), before);
  const failure = JSON.parse(await readFile(path.join(output, "result.json"), "utf8"));
  assert.equal(failure.status, "rolledBack");
  assert.equal(await readFile(path.join(output, "rollback.status"), "utf8"), "rolled-back\n");
  const audit = await db.collection(RUNS).findOne({ _id: failure.runId });
  assert.equal(audit.failedMigration, "006-region-event-slugs");
  assert.equal(audit.revision, "test-revision");
  await db.collection("events").deleteOne({ _id: "event_2" });
  assert.equal(await invoke(), 0);
  assert.deepEqual((await readdir(output)).sort(), ["result.json"]);
  assert.equal(JSON.parse(await readFile(path.join(output, "result.json"), "utf8")).status, "succeeded");
});

test("all real migrations finish before success and reruns skip completed IDs", { skip: !uri }, async t => {
  const db = await setup(t); await seed(db);
  const result = await runMigrations(db, migrations, options);
  assert.equal(result.status, "succeeded");
  assert.equal(await db.collection(TRACKING).countDocuments(), 8);
  assert.equal((await db.collection("memberUsers").findOne()).region, "breda_tilburg");
  assert.deepEqual((await db.collection("memberUsers").findOne()).roles, ["regional_board_member", "member"]);
  assert.equal((await db.collection("events").findOne()).slug, "welcome");
  assert.equal(await db.collection(LOCKS).countDocuments(), 0);
  assert.equal((await db.listCollections().toArray()).filter(item => item.name.startsWith("migrationBackup")).length, 0);
  const before = await state(db);
  await runMigrations(db, migrations.map(item => ({ id: item.id, up: () => { throw new Error("Already-applied migration was rerun"); } })), options);
  assert.equal(await state(db), before);
});

test("the full migration batch preserves past, archived and cancelled event documents", { skip: !uri }, async t => {
  const db = await setup(t); await seed(db);
  const historical = [
    { _id: "past", status: "opened", date: new Date("2000-01-01") },
    { _id: "archived", status: "archived", date: new Date("2099-01-01") },
    { _id: "cancelled", status: "cancelled", date: new Date("2099-01-01") },
  ].map(event => ({ ...event, title: "Historical", region: "breda", bgImage: 1, earlyBird: { ticketTimer: "bad" } }));
  await db.collection("events").insertMany(historical);
  await runMigrations(db, migrations, options);
  for (const original of historical) assert.deepEqual(await db.collection("events").findOne({ _id: original._id }), original);
});

test("failure after all real migrations restores data, collection names, options, indexes and tracking", { skip: !uri }, async t => {
  const db = await setup(t); await seed(db);
  const before = await state(db);
  const logs = [];
  await assert.rejects(runMigrations(db, [...migrations, { id: "008-fail", async up(scoped) {
    await scoped.collection("events").updateOne({ _id: "event_1" }, { $set: { failedAction: true } });
    throw new Error("Injected failure after event update");
  } }], { ...options, log: line => logs.push(line) }), error => error.result.status === "rolledBack" && error.result.safeToResume);
  assert.equal(await state(db), before);
  const audit = await db.collection(RUNS).findOne();
  assert.equal(audit.failedMigration, "008-fail");
  assert.match(audit.error.message, /Injected failure/);
  assert.equal(audit.completedMigrations.length, 7);
  assert.equal(await db.collection(LOCKS).countDocuments(), 0);
  assert.ok(logs.some(line => line.includes('"phase":"rollback"')));
});

test("a failure within a rename migration restores its partially completed operations", { skip: !uri }, async t => {
  const db = await setup(t); await seed(db); const before = await state(db);
  await assert.rejects(runMigrations(db, [{ id: "rename-failure", async up(scoped) {
    await scoped.collection("memberUsers").drop();
    await scoped.collection("users").rename("memberUsers");
    await scoped.collection("events").createIndex({ region: 1 });
    throw new Error("Rename batch interrupted");
  } }], options));
  assert.equal(await state(db), before);
});

test("real Mongo unique-index failure rolls back prior writes and records the Mongo code", { skip: !uri }, async t => {
  const db = await setup(t);
  await db.collection("items").insertMany([{ _id: 1, name: "same" }, { _id: 2, name: "same" }]);
  const before = await state(db);
  await assert.rejects(runMigrations(db, [{ id: "bad-index", async up(scoped) {
    await scoped.collection("items").updateMany({}, { $set: { changed: true } });
    await scoped.collection("items").createIndex({ name: 1 }, { unique: true });
  } }], options));
  assert.equal(await state(db), before);
  assert.equal((await db.collection(RUNS).findOne()).error.code, "11000");
});

test("writers must be stopped; concurrent runner cannot steal the deployment lock", { skip: !uri }, async t => {
  const db = await setup(t);
  await assert.rejects(runMigrations(db, [], { log: () => {} }), /blocked/);
  assert.equal(await db.collection(LOCKS).countDocuments(), 0);
  await db.collection(LOCKS).insertOne({ _id: "deployment", runId: "other-run" });
  await assert.rejects(runMigrations(db, [], options), error => error.result.status === "blocked" && !error.result.safeToResume);
  assert.equal((await db.collection(LOCKS).findOne()).runId, "other-run");
});

test("SIGTERM-style cancellation rolls back the in-flight batch", { skip: !uri }, async t => {
  const db = await setup(t); await seed(db); const before = await state(db);
  const controller = new AbortController();
  await assert.rejects(runMigrations(db, [{ id: "cancelled", async up(scoped) {
    await scoped.collection("events").deleteMany({});
    controller.abort();
  } }], { ...options, signal: controller.signal }), error => error.result.safeToResume);
  assert.equal(await state(db), before);
});

test("failed rollback keeps its lock and backups; explicit recovery retries restoration", { skip: !uri }, async t => {
  const db = await setup(t); await seed(db); const before = await state(db);
  let backupName;
  let original;
  let runId;
  await assert.rejects(runMigrations(db, [{ id: "rollback-fails", async up(scoped) {
    await scoped.collection("events").deleteMany({});
    const run = await db.collection(RUNS).findOne(); runId = run._id;
    backupName = run.snapshots.find(item => item.name === "events").backup;
    original = await db.collection(backupName).find({}).toArray();
    await db.collection(backupName).deleteMany({}); // Simulate damaged/unavailable backup.
    throw new Error("Injected migration failure");
  } }], options), error => error.result.status === "rollbackFailed" && !error.result.safeToResume);
  assert.equal((await db.collection(LOCKS).findOne()).runId, runId);
  assert.equal((await db.collection(RUNS).findOne()).rollbackErrors.length, 1);
  await db.collection(backupName).insertMany(original);
  assert.equal((await recoverMigrationRun(db, runId, options)).safeToResume, true);
  assert.equal(await state(db), before);
});

test("hard process exit preserves the journal so a later recovery can undo the partial batch", { skip: !uri }, async t => {
  const db = await setup(t); await seed(db); const before = await state(db);
  const code = `import { MongoClient } from 'mongodb';
    import { runMigrations } from './services/migrations/runner.js';
    const client = await new MongoClient(process.env.BGSNL_MIGRATION_TEST_URL).connect();
    await runMigrations(client.db(${JSON.stringify(db.databaseName)}), [{id:'killed', async up(db) {
      await db.collection('events').deleteMany({}); process.exit(17);
    }}], {writersStopped:true,log:()=>{}});`;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" });
    child.on("error", reject); child.on("exit", resolve);
  });
  assert.equal(exitCode, 17);
  const run = await db.collection(RUNS).findOne();
  assert.equal(run.status, "running");
  await assert.rejects(runMigrations(db, migrations, options), /blocked/);
  await recoverMigrationRun(db, run._id, options);
  assert.equal(await state(db), before);
});
