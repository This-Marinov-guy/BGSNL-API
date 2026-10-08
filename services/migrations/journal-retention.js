import mongoose from "mongoose";
import { JOURNAL } from "./runner.js";

export const MIGRATION_JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Keep unfinished runs and their snapshots indefinitely so an operator can
// recover them. A recovered rollback ages from recovery, not the original run.
export async function pruneMigrationJournal({ now = new Date(), db = mongoose.connection.db } = {}) {
  const timestamp = new Date(now).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("Invalid migration journal cleanup time");
  if (!db) throw new Error("Migration journal cleanup requires a database connection");
  const cutoff = new Date(timestamp - MIGRATION_JOURNAL_RETENTION_MS);
  const journal = db.collection(JOURNAL);
  const lock = await journal.findOne({ _id: "lock:deployment" });
  const completed = {
    kind: "run",
    status: { $in: ["succeeded", "rolledBack"] },
    $or: [
      { recoveredAt: { $type: "date", $lt: cutoff } },
      { recoveredAt: null, finishedAt: { $type: "date", $lt: cutoff } },
    ],
  };
  let runsDeleted = 0;
  let snapshotsDeleted = 0;
  const cursor = journal.find(completed, { projection: { _id: 1, runId: 1, status: 1 } });
  try {
    for await (const run of cursor) {
      if (typeof run.runId !== "string" || run._id !== `run:${run.runId}` || run.runId === lock?.runId) continue;
      const snapshots = await journal.deleteMany({ kind: "snapshot", runId: run.runId });
      snapshotsDeleted += snapshots.deletedCount;
      const result = await journal.deleteOne({ _id: run._id, kind: "run", status: run.status });
      runsDeleted += result.deletedCount;
    }
  } finally { await cursor.close(); }
  return { runsDeleted, snapshotsDeleted, cutoff };
}
