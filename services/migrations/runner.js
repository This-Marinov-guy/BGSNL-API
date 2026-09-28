import { randomUUID } from "node:crypto";

// The whole rollback system lives in this one collection. Run records, the
// deployment lock and every snapshotted document are distinguished by an "_id"
// prefix and a "kind" field, so a deployment adds exactly one collection to the
// database instead of a lock collection, a run collection and one backup
// collection per touched collection.
export const JOURNAL = "migrationJournal";
export const TRACKING = "_migrations";

const LOCK_ID = "lock:deployment";
const runKey = runId => `run:${runId}`;
const snapshotKey = (runId, index, seq) => `snap:${runId}:${index}:${seq}`;
const BATCH = 250;

// Migrations may touch application collections and the tracking ledger (so a
// rollback also removes its tracking rows), but never the journal itself.
export const internalCollection = name => name === JOURNAL || name.startsWith("system.");

export function safeError(error, secrets = []) {
  const clean = value => {
    let text = String(value || "").replace(/mongodb(?:\+srv)?:\/\/[^\s"']+/gi, "[database URI redacted]")
      .replace(/dup key:\s*\{[^\n]*\}/gi, "dup key: [value redacted]");
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[redacted]");
    return text.slice(0, 12000);
  };
  return { name: clean(error?.name || "Error"), message: clean(error?.message || error),
    ...(error?.code !== undefined ? { code: clean(error.code) } : {}), stack: clean(error?.stack) };
}

export class MigrationFailure extends Error {
  constructor(result, cause) {
    super(`Migration run ${result.runId}: ${result.status}`, { cause });
    this.result = result;
  }
}

const exists = async (db, name) => (await db.listCollections({ name }).toArray())[0];
const indexOptions = index => Object.fromEntries(Object.entries(index).filter(([key]) => !["v", "ns", "background"].includes(key)));
const snapshotFilter = (runId, index) => ({ kind: "snapshot", runId, index });
const storedCount = (db, runId, index) => db.collection(JOURNAL).countDocuments(snapshotFilter(runId, index));

// Copies a collection into the journal. Preserves BSON numeric/binary types:
// default driver promotion can turn a stored Double or small Long into an
// Int32. The journal has no schema validator of its own, so these inserts
// never need the bypassDocumentValidation privilege.
async function captureDocuments(db, runId, index, source) {
  const journal = db.collection(JOURNAL);
  const cursor = source.find({}, { promoteValues: false }).batchSize(BATCH);
  let batch = [];
  let copied = 0;
  try {
    for await (const doc of cursor) {
      batch.push({ _id: snapshotKey(runId, index, copied + batch.length), kind: "snapshot", runId, index, seq: copied + batch.length, doc });
      if (batch.length === BATCH) {
        await journal.insertMany(batch, { ordered: true });
        copied += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      await journal.insertMany(batch, { ordered: true });
      copied += batch.length;
    }
    return copied;
  } finally { await cursor.close(); }
}

// Only a collection that carries its own validator needs the bypass privilege,
// and only on the way back in: documents that predate a validator must still
// restore exactly as they were.
async function restoreDocuments(db, runId, index, target, validated) {
  const insertOptions = validated ? { ordered: true, bypassDocumentValidation: true } : { ordered: true };
  const cursor = db.collection(JOURNAL).find(snapshotFilter(runId, index), { promoteValues: false }).sort({ seq: 1 }).batchSize(BATCH);
  let batch = [];
  let restored = 0;
  try {
    for await (const row of cursor) {
      batch.push(row.doc);
      if (batch.length === BATCH) {
        await target.insertMany(batch, insertOptions);
        restored += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      await target.insertMany(batch, insertOptions);
      restored += batch.length;
    }
    return restored;
  } finally { await cursor.close(); }
}

// A deliberately narrow database facade: migrations cannot bypass the snapshot
// journal using db.command(), aggregate $out, a raw client, or unknown methods.
function journalDatabase(db, runId, { checkCancelled, progress }) {
  const captured = new Map();
  const entries = [];
  const pendingWrites = new Set();
  const writeErrors = [];
  let snapshotQueue = Promise.resolve();
  let closed = false;
  const checked = () => { if (closed) throw new Error("Migration batch is closed"); checkCancelled(); };
  const write = operation => {
    const promise = Promise.resolve().then(() => { checked(); return operation(); });
    pendingWrites.add(promise);
    promise.then(() => pendingWrites.delete(promise), error => { pendingWrites.delete(promise); writeErrors.push(error); });
    return promise;
  };
  const assertName = name => {
    if (typeof name !== "string" || !name || internalCollection(name)) throw new Error("Migration attempted to access a reserved collection");
  };
  const capture = async name => {
    assertName(name);
    checked();
    if (captured.has(name)) return captured.get(name);
    const pending = snapshotQueue.then(async () => {
      checked();
      const info = await exists(db, name);
      if (info && (info.type !== "collection" || info.options?.timeseries || info.options?.clusteredIndex || info.options?.encryptedFields)) {
        throw new Error(`Rollback snapshots do not support this collection type: ${name}`);
      }
      const index = entries.length;
      const entry = { name, index, existed: !!info, ready: false,
        options: info?.options || {}, indexes: info ? await db.collection(name).indexes() : [] };
      entries.push(entry);
      await db.collection(JOURNAL).updateOne({ _id: runKey(runId) }, { $push: { snapshots: entry } });
      if (info) {
        const before = await db.collection(name).countDocuments();
        const copied = await captureDocuments(db, runId, index, db.collection(name));
        if (copied !== before || copied !== await storedCount(db, runId, index) || copied !== await db.collection(name).countDocuments()) {
          throw new Error(`Collection changed while backing up ${name}; stop all database writers before retrying`);
        }
        entry.count = copied;
      }
      checked();
      await db.collection(JOURNAL).updateOne({ _id: runKey(runId) }, { $set: { [`snapshots.${index}.ready`]: true, [`snapshots.${index}.count`]: entry.count || 0 } });
      entry.ready = true;
      progress({ phase: "backup", collection: name, documents: entry.count || 0 });
      return entry;
    });
    snapshotQueue = pending.catch(() => {});
    captured.set(name, pending);
    return pending;
  };
  const readMethods = new Set(["find", "findOne", "countDocuments", "estimatedDocumentCount", "indexes", "listIndexes"]);
  const writeMethods = new Set(["insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "bulkWrite", "createIndex", "createIndexes", "dropIndex", "dropIndexes", "drop", "rename"]);
  const collection = name => {
    assertName(name);
    const raw = db.collection(name);
    return new Proxy({}, { get(_target, property) {
      if (property === "then") return undefined; // Collections are not promises.
      if (property === "collectionName") return name;
      if (readMethods.has(property)) return raw[property].bind(raw);
      if (writeMethods.has(property)) return (...args) => write(async () => {
        await capture(name);
        if (property === "rename") await capture(args[0]);
        checked();
        const result = await raw[property](...args);
        return property === "rename" ? collection(args[0]) : result;
      });
      throw new Error(`Unsupported migration collection operation: ${String(property)}`);
    } });
  };
  return { close: async () => { closed = true; await Promise.allSettled([...pendingWrites]); return writeErrors; }, db: {
    collection,
    listCollections: (...args) => ({ toArray: async () => (await db.listCollections(...args).toArray()).filter(info => !internalCollection(info.name)) }),
    createCollection: (name, options) => write(async () => { await capture(name); checked(); await db.createCollection(name, options); return collection(name); }),
  } };
}

// Rebuilds each touched collection in place from the journal, newest snapshot
// first. There is no temporary collection to swap in: the journal still holds
// every document, so an interrupted restoration is simply replayed by
// recoverMigrationRun, which drops and rebuilds the collection again.
async function restore(db, run, progress) {
  const errors = [];
  for (let index = (run.snapshots || []).length - 1; index >= 0; index--) {
    const entry = run.snapshots[index];
    // A mutation is never allowed until its snapshot is durable and complete.
    if (!entry.ready) continue;
    try {
      if (!entry.existed) {
        if (await exists(db, entry.name)) await db.collection(entry.name).drop();
      } else {
        if (await storedCount(db, run.runId, index) !== entry.count) {
          throw new Error(`Missing or incomplete rollback snapshot for ${entry.name}`);
        }
        if (await exists(db, entry.name)) await db.collection(entry.name).drop();
        await db.createCollection(entry.name, entry.options);
        const copied = await restoreDocuments(db, run.runId, index, db.collection(entry.name), !!entry.options?.validator);
        if (copied !== entry.count || await db.collection(entry.name).countDocuments() !== entry.count) throw new Error(`Rollback count mismatch for ${entry.name}`);
        const indexes = entry.indexes.filter(item => item.name !== "_id_").map(indexOptions);
        if (indexes.length) await db.collection(entry.name).createIndexes(indexes);
      }
      progress({ phase: "rollback", collection: entry.name, status: "restored" });
    } catch (error) {
      errors.push({ collection: entry.name, error });
      progress({ phase: "rollback", collection: entry.name, status: "failed", error });
    }
  }
  return errors;
}

async function cleanupSnapshots(db, run, progress) {
  try { await db.collection(JOURNAL).deleteMany({ kind: "snapshot", runId: run.runId }); }
  catch (error) { progress({ phase: "backup-cleanup", error }); }
}

export async function runMigrations(db, migrations, { writersStopped = false, signal, secrets = [], log = console.log, revision = "unknown" } = {}) {
  const runId = randomUUID();
  const progress = event => log(JSON.stringify({ runId, time: new Date().toISOString(), ...event,
    ...(event.error ? { error: safeError(event.error, secrets) } : {}) }));
  const checkCancelled = () => { if (signal?.aborted) throw new Error("Migration interrupted; rolling back this batch"); };
  if (!writersStopped) throw new MigrationFailure({ runId, status: "blocked", safeToResume: false }, new Error("Stop all API/worker writers and pass --writers-stopped"));
  const ids = migrations.map(item => item.id);
  if (new Set(ids).size !== ids.length || migrations.some(item => !item.id || typeof item.up !== "function")) throw new Error("Migration IDs must be unique and each migration must export up(db)");
  try {
    await db.collection(JOURNAL).createIndex({ kind: 1, runId: 1, index: 1, seq: 1 }, { name: "journal_snapshot_order" });
    await db.collection(JOURNAL).insertOne({ _id: LOCK_ID, kind: "lock", runId, startedAt: new Date(), revision });
  } catch (error) {
    progress({ phase: "lock", error });
    throw new MigrationFailure({ runId, status: "blocked", safeToResume: false }, error);
  }
  let currentMigration = null;
  const journal = journalDatabase(db, runId, { checkCancelled, progress });
  let committed = false;
  try {
    await db.collection(JOURNAL).insertOne({ _id: runKey(runId), kind: "run", runId, status: "running", revision, startedAt: new Date(), snapshots: [], completedMigrations: [] });
    const applied = new Set((await db.collection(TRACKING).find({}, { projection: { _id: 1 } }).toArray()).map(item => item._id));
    for (const migration of migrations) {
      checkCancelled();
      if (applied.has(migration.id)) { progress({ migrationId: migration.id, phase: "skip" }); continue; }
      currentMigration = migration.id;
      await db.collection(JOURNAL).updateOne({ _id: runKey(runId) }, { $set: { currentMigration } });
      progress({ migrationId: migration.id, phase: "start" });
      await migration.up(journal.db);
      checkCancelled();
      await journal.db.collection(TRACKING).insertOne({ _id: migration.id, appliedAt: new Date(), runId });
      await db.collection(JOURNAL).updateOne({ _id: runKey(runId) }, { $push: { completedMigrations: migration.id } });
      progress({ migrationId: migration.id, phase: "complete" });
    }
    const writeErrors = await journal.close();
    if (writeErrors.length) throw writeErrors[0];
    checkCancelled();
    await db.collection(JOURNAL).updateOne({ _id: runKey(runId) }, { $set: { status: "succeeded", finishedAt: new Date() } });
    committed = true;
  } catch (error) {
    // A rejected Promise.all must not leave another write racing restoration.
    await journal.close();
    progress({ migrationId: currentMigration, phase: "failed", error });
    let rollbackErrors = [];
    try {
      await db.collection(JOURNAL).updateOne({ _id: runKey(runId) }, { $set: { kind: "run", runId, status: "rollingBack", failedMigration: currentMigration, error: safeError(error, secrets) } }, { upsert: true });
      const run = await db.collection(JOURNAL).findOne({ _id: runKey(runId) });
      rollbackErrors = await restore(db, run, progress);
      const status = rollbackErrors.length ? "rollbackFailed" : "rolledBack";
      await db.collection(JOURNAL).updateOne({ _id: runKey(runId) }, { $set: { status, finishedAt: new Date(),
        rollbackErrors: rollbackErrors.map(item => ({ collection: item.collection, error: safeError(item.error, secrets) })) } });
      if (!rollbackErrors.length) await db.collection(JOURNAL).deleteOne({ _id: LOCK_ID, runId });
      const result = { runId, status, safeToResume: !rollbackErrors.length };
      progress({ phase: "result", ...result });
      throw new MigrationFailure(result, error);
    } catch (rollbackError) {
      if (rollbackError instanceof MigrationFailure) throw rollbackError;
      progress({ phase: "rollback-failed", error: rollbackError });
      // Do not steal/release this lock. An operator must explicitly recover it.
      throw new MigrationFailure({ runId, status: "rollbackFailed", safeToResume: false }, rollbackError);
    }
  }
  if (committed) {
    const run = await db.collection(JOURNAL).findOne({ _id: runKey(runId) });
    await cleanupSnapshots(db, run, progress);
    await db.collection(JOURNAL).deleteOne({ _id: LOCK_ID, runId });
    const result = { runId, status: "succeeded", safeToResume: false };
    progress({ phase: "result", ...result });
    return result;
  }
  throw new Error("Unexpected migration runner state");
}

export async function recoverMigrationRun(db, runId, { writersStopped = false, secrets = [], log = console.log } = {}) {
  if (!writersStopped) throw new Error("Recovery requires stopped database writers");
  const run = await db.collection(JOURNAL).findOne({ _id: runKey(runId) });
  const lock = await db.collection(JOURNAL).findOne({ _id: LOCK_ID });
  if (!run || (lock && lock.runId !== runId) || !["running", "rollingBack", "rollbackFailed", "rolledBack", "succeeded"].includes(run.status)) throw new Error(`Run cannot be recovered; inspect the ${JOURNAL} collection`);
  const progress = event => log(JSON.stringify({ runId, time: new Date().toISOString(), ...event,
    ...(event.error ? { error: safeError(event.error, secrets) } : {}) }));
  // A crash after the success marker must not undo a committed deployment.
  if (run.status === "succeeded") {
    await db.collection(JOURNAL).deleteOne({ _id: LOCK_ID, runId });
    return { runId, status: "succeeded", safeToResume: false };
  }
  if (!lock && run.status !== "rolledBack") throw new Error("Missing recovery lock; manual review required");
  if (run.status !== "rolledBack") {
    const errors = await restore(db, run, progress);
    await db.collection(JOURNAL).updateOne({ _id: runKey(runId) }, { $set: { status: errors.length ? "rollbackFailed" : "rolledBack", recoveredAt: new Date(),
      rollbackErrors: errors.map(item => ({ collection: item.collection, error: safeError(item.error, secrets) })) } });
    if (errors.length) throw new MigrationFailure({ runId, status: "rollbackFailed", safeToResume: false });
  }
  await db.collection(JOURNAL).deleteOne({ _id: LOCK_ID, runId });
  return { runId, status: "rolledBack", safeToResume: true };
}
