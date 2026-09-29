import dotenv from "dotenv";
import mongoose from "mongoose";
import { startSpreadsheetSyncWorker } from "./services/jobs/spreadsheet-sync-worker.js";
import { closeSpreadsheetSyncQueue } from "./services/jobs/spreadsheet-sync-queue.js";
import { scheduleGuestListReconciliation } from "./services/jobs/guest-list-reconciliation.js";

dotenv.config();

const mongoUri = () => {
  const { DB_USER, DB_PASS, DB } = process.env;
  if (!DB_USER || !DB_PASS || !DB) throw new Error("MongoDB connection settings are required for the background worker");
  return `mongodb+srv://${DB_USER}:${DB_PASS}@${DB}`;
};

let worker;
let stopping;

async function stop(signal) {
  if (stopping) return stopping;
  stopping = (async () => {
    console.log(`${signal} received. Stopping BGSNL background worker...`);
    await worker?.stop();
    await closeSpreadsheetSyncQueue();
    await mongoose.connection.close();
    console.log("BGSNL background worker stopped.");
  })();
  return stopping;
}

async function main() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(mongoUri());
  if ((process.env.GUEST_LIST_RECONCILIATION_ENABLED ?? (process.env.APP_ENV === "prod" ? "true" : "false")) === "true") {
    await scheduleGuestListReconciliation();
  }
  worker = startSpreadsheetSyncWorker();
  console.log("BGSNL spreadsheet synchronization worker is running.");
}

process.once("SIGTERM", () => stop("SIGTERM").then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); }));
process.once("SIGINT", () => stop("SIGINT").then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); }));

main().catch(async (error) => {
  console.error("BGSNL background worker failed to start", error);
  await worker?.stop();
  await closeSpreadsheetSyncQueue();
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  process.exitCode = 1;
});
