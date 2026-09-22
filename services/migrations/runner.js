import { randomUUID } from "node:crypto";

export const RUNS = "migrationRuns";
export const LOCKS = "migrationLocks";
export const TRACKING = "_migrations";
const BACKUP_PREFIX = "migrationBackup";
const RESTORE_PREFIX = "migrationRestore";
export const internalCollection = name => [RUNS, LOCKS].includes(name) || name.startsWith(BACKUP_PREFIX) || name.startsWith(RESTORE_PREFIX) || name.startsWith("system.");

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

async function copyDocuments(source, target) {
  let batch = [];
  let copied = 0;
  // Preserve BSON numeric/binary types; default driver promotion can turn a
  // stored Double or small Long into an Int32 when inserting the snapshot.
  const cursor = source.find({}, { promoteValues: false }).batchSize(250);
  try {
    for await (const doc of cursor) {
      batch.push(doc);
      if (batch.length === 250) {
        await target.insertMany(batch, { ordered: true, bypassDocumentValidation: true });
        copied += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      await target.insertMany(batch, { ordered: true, bypassDocumentValidation: true });
      copied += batch.length;
    }
    return copied;
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
      const backup = `${BACKUP_PREFIX}${runId.replaceAll("-", "")}${index}`;
      const entry = { name, backup, existed: !!info, ready: false,
        options: info?.options || {}, indexes: info ? await db.collection(name).indexes() : [] };
      entries.push(entry);
      await db.collection(RUNS).updateOne({ _id: runId }, { $push: { snapshots: entry } });
      if (info) {
        await db.createCollection(backup);
        const before = await db.collection(name).countDocuments();
        const copied = await copyDocuments(db.collection(name), db.collection(backup));
        if (copied !== before || copied !== await db.collection(backup).countDocuments() || copied !== await db.collection(name).countDocuments()) {
          throw new Error(`Collection changed while backing up ${name}; stop all database writers before retrying`);
        }
        entry.count = copied;
      }
      checked();
      await db.collection(RUNS).updateOne({ _id: runId }, { $set: { [`snapshots.${index}.ready`]: true, [`snapshots.${index}.count`]: entry.count || 0 } });
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
        if (!await exists(db, entry.backup) || await db.collection(entry.backup).countDocuments() !== entry.count) {
          throw new Error(`Missing or incomplete rollback snapshot for ${entry.name}`);
        }
        const temporary = `${RESTORE_PREFIX}${run._id.replaceAll("-", "")}${index}`;
        if (await exists(db, temporary)) await db.collection(temporary).drop();
        await db.createCollection(temporary, entry.options);
        const copied = await copyDocuments(db.collection(entry.backup), db.collection(temporary));
        if (copied !== entry.count || await db.collection(temporary).countDocuments() !== entry.count) throw new Error(`Rollback count mismatch for ${entry.name}`);
        const indexes = entry.indexes.filter(item => item.name !== "_id_").map(indexOptions);
        if (indexes.length) await db.collection(temporary).createIndexes(indexes);
        // Build the restoration fully before replacing the changed collection.
        await db.collection(temporary).rename(entry.name, { dropTarget: true });
      }
      progress({ phase: "rollback", collection: entry.name, status: "restored" });
    } catch (error) {
      errors.push({ collection: entry.name, error });
      progress({ phase: "rollback", collection: entry.name, status: "failed", error });
    }
  }
  return errors;
}

async function cleanupBackups(db, run, progress) {
  for (const entry of run.snapshots || []) {
    try { if (await exists(db, entry.backup)) await db.collection(entry.backup).drop(); }
    catch (error) { progress({ phase: "backup-cleanup", collection: entry.backup, error }); }
  }
}

export async function runMigrations(db, migrations, { writersStopped = false, signal, secrets = [], log = console.log, revision = "unknown" } = {}) {
  const runId = randomUUID();
  const progress = event => log(JSON.stringify({ runId, time: new Date().toISOString(), ...event,
    ...(event.error ? { error: safeError(event.error, secrets) } : {}) }));
  const checkCancelled = () => { if (signal?.aborted) throw new Error("Migration interrupted; rolling back this batch"); };
  if (!writersStopped) throw new MigrationFailure({ runId, status: "blocked", safeToResume: false }, new Error("Stop all API/worker writers and pass --writers-stopped"));
  const ids = migrations.map(item => item.id);
  if (new Set(ids).size !== ids.length || migrations.some(item => !item.id || typeof item.up !== "function")) throw new Error("Migration IDs must be unique and each migration must export up(db)");
  try { await db.collection(LOCKS).insertOne({ _id: "deployment", runId, startedAt: new Date(), revision }); }
  catch (error) {
    progress({ phase: "lock", error });
    throw new MigrationFailure({ runId, status: "blocked", safeToResume: false }, error);
  }
  let currentMigration = null;
  const journal = journalDatabase(db, runId, { checkCancelled, progress });
  let committed = false;
  try {
    await db.collection(RUNS).insertOne({ _id: runId, status: "running", revision, startedAt: new Date(), snapshots: [], completedMigrations: [] });
    const applied = new Set((await db.collection(TRACKING).find({}, { projection: { _id: 1 } }).toArray()).map(item => item._id));
    for (const migration of migrations) {
      checkCancelled();
      if (applied.has(migration.id)) { progress({ migrationId: migration.id, phase: "skip" }); continue; }
      currentMigration = migration.id;
      await db.collection(RUNS).updateOne({ _id: runId }, { $set: { currentMigration } });
      progress({ migrationId: migration.id, phase: "start" });
      await migration.up(journal.db);
      checkCancelled();
      await journal.db.collection(TRACKING).insertOne({ _id: migration.id, appliedAt: new Date(), runId });
      await db.collection(RUNS).updateOne({ _id: runId }, { $push: { completedMigrations: migration.id } });
      progress({ migrationId: migration.id, phase: "complete" });
    }
    const writeErrors = await journal.close();
    if (writeErrors.length) throw writeErrors[0];
    checkCancelled();
    await db.collection(RUNS).updateOne({ _id: runId }, { $set: { status: "succeeded", finishedAt: new Date() } });
    committed = true;
  } catch (error) {
    // A rejected Promise.all must not leave another write racing restoration.
    await journal.close();
    progress({ migrationId: currentMigration, phase: "failed", error });
    let rollbackErrors = [];
    try {
      await db.collection(RUNS).updateOne({ _id: runId }, { $set: { status: "rollingBack", failedMigration: currentMigration, error: safeError(error, secrets) } }, { upsert: true });
      const run = await db.collection(RUNS).findOne({ _id: runId });
      rollbackErrors = await restore(db, run, progress);
      const status = rollbackErrors.length ? "rollbackFailed" : "rolledBack";
      await db.collection(RUNS).updateOne({ _id: runId }, { $set: { status, finishedAt: new Date(),
        rollbackErrors: rollbackErrors.map(item => ({ collection: item.collection, error: safeError(item.error, secrets) })) } });
      if (!rollbackErrors.length) await db.collection(LOCKS).deleteOne({ _id: "deployment", runId });
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
    const run = await db.collection(RUNS).findOne({ _id: runId });
    await cleanupBackups(db, run, progress);
    await db.collection(LOCKS).deleteOne({ _id: "deployment", runId });
    const result = { runId, status: "succeeded", safeToResume: false };
    progress({ phase: "result", ...result });
    return result;
  }
  throw new Error("Unexpected migration runner state");
}

export async function recoverMigrationRun(db, runId, { writersStopped = false, secrets = [], log = console.log } = {}) {
  if (!writersStopped) throw new Error("Recovery requires stopped database writers");
  const run = await db.collection(RUNS).findOne({ _id: runId });
  const lock = await db.collection(LOCKS).findOne({ _id: "deployment" });
  if (!run || (lock && lock.runId !== runId) || !["running", "rollingBack", "rollbackFailed", "rolledBack", "succeeded"].includes(run.status)) throw new Error("Run cannot be recovered; inspect migrationRuns and migrationLocks");
  const progress = event => log(JSON.stringify({ runId, time: new Date().toISOString(), ...event,
    ...(event.error ? { error: safeError(event.error, secrets) } : {}) }));
  // A crash after the success marker must not undo a committed deployment.
  if (run.status === "succeeded") {
    await db.collection(LOCKS).deleteOne({ _id: "deployment", runId });
    return { runId, status: "succeeded", safeToResume: false };
  }
  if (!lock && run.status !== "rolledBack") throw new Error("Missing recovery lock; manual review required");
  if (run.status !== "rolledBack") {
    const errors = await restore(db, run, progress);
    await db.collection(RUNS).updateOne({ _id: runId }, { $set: { status: errors.length ? "rollbackFailed" : "rolledBack", recoveredAt: new Date(),
      rollbackErrors: errors.map(item => ({ collection: item.collection, error: safeError(item.error, secrets) })) } });
    if (errors.length) throw new MigrationFailure({ runId, status: "rollbackFailed", safeToResume: false });
  }
  await db.collection(LOCKS).deleteOne({ _id: "deployment", runId });
  return { runId, status: "rolledBack", safeToResume: true };
}
