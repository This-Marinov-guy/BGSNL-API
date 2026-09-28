// One-off cleanup after the rollback journal moved into a single collection
// (services/migrations/runner.js). Removes the bookkeeping collections the old
// runner created. Run from the BGSNL-API directory:
//
//   node <path>/drop-legacy-migration-collections.mjs                 # dry run
//   node <path>/drop-legacy-migration-collections.mjs --apply \
//        --production-confirm=DROP_LEGACY_MIGRATION_COLLECTIONS
//
import "dotenv/config";
import { MongoClient } from "mongodb";

const apply = process.argv.includes("--apply");
const confirmed = process.argv.includes("--production-confirm=DROP_LEGACY_MIGRATION_COLLECTIONS");
if (apply && process.env.APP_ENV === "prod" && !confirmed) {
  console.error("Production safety stop. Add --production-confirm=DROP_LEGACY_MIGRATION_COLLECTIONS.");
  process.exit(1);
}

const TARGETS = ["migrationRuns", "migrationLocks", "eventProductionUpgradeBackups"];
const client = new MongoClient(`mongodb+srv://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASS)}@${process.env.DB}`,
  { serverSelectionTimeoutMS: 15000, readPreference: "primary", writeConcern: { w: "majority" } });
await client.connect();
const db = client.db();
console.log(`database: ${db.databaseName}   mode: ${apply ? "APPLY" : "dry run"}\n`);

// Guard 1: never discard bookkeeping while a deployment lock is held.
if (await db.collection("migrationLocks").findOne({ _id: "deployment" })) {
  throw new Error("A deployment lock is held; refusing to remove bookkeeping collections");
}
// Guard 2: never discard the audit trail of an unresolved run.
for (const run of await db.collection("migrationRuns").find({}).toArray()) {
  if (!["rolledBack", "succeeded"].includes(run.status) || (run.rollbackErrors || []).length) {
    throw new Error(`Run ${run._id} is unresolved (status=${run.status}); refusing`);
  }
}
// Guard 3: every numbered migration must already be recorded as applied.
const applied = await db.collection("_migrations").countDocuments();
if (applied !== 10) throw new Error(`Expected 10 tracked migrations, found ${applied}; refusing`);
// Guard 4: the new journal must not be mid-run.
if (await db.collection("migrationJournal").findOne({ _id: "lock:deployment" })) {
  throw new Error("The new migrationJournal holds a lock; refusing");
}

const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name);
const doomed = [...TARGETS, ...names.filter(name => name.startsWith("migrationBackup") || name.startsWith("migrationRestore"))]
  .filter(name => names.includes(name));

for (const name of doomed) {
  const count = await db.collection(name).countDocuments();
  if (apply) { await db.collection(name).drop(); console.log(`  DROPPED  ${name} (${count} doc(s))`); }
  else console.log(`  would drop  ${name} (${count} doc(s))`);
}
if (!doomed.length) console.log("  nothing to drop");

console.log("\nremaining collections:");
for (const name of (await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name).sort()) {
  console.log(`  ${String(await db.collection(name).countDocuments()).padStart(6)}  ${name}`);
}
await client.close();
