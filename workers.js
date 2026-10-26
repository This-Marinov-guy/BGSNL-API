import dotenv from "dotenv";
import mongoose from "mongoose";
import { startSpreadsheetSyncWorker } from "./services/jobs/spreadsheet-sync-worker.js";
import { closeSpreadsheetSyncQueue } from "./services/jobs/spreadsheet-sync-queue.js";
import { scheduleGuestListReconciliation } from "./services/jobs/guest-list-reconciliation.js";
import { startMemberRevenueWorker } from "./services/subscriptions/member-revenue-worker.js";
import { closeMemberRevenueQueue, scheduleMemberRevenueSweep } from "./services/subscriptions/member-revenue-queue.js";
import { memberRevenueEnabled } from "./util/config/member-revenue.js";
import JobFailureState from "./models/JobFailureState.js";
import { jobFailurePolicy } from "./services/monitoring/job-failure-policy.js";
import { startBusinessHourlyCheck } from "./services/jobs/calendar-check.js";

dotenv.config();

const mongoUri = () => {
  const { DB_USER, DB_PASS, DB } = process.env;
  if (!DB_USER || !DB_PASS || !DB) throw new Error("MongoDB connection settings are required for the background worker");
  return `mongodb+srv://${DB_USER}:${DB_PASS}@${DB}`;
};

let worker;
let revenueWorker;
let stopAlertSchedule;
let alertRun;
let stopping;

const retryAlerts = () => {
  if (alertRun) return alertRun;
  alertRun = jobFailurePolicy.retryAlerts().finally(() => { alertRun = null; });
  return alertRun;
};

async function stop(signal) {
  if (stopping) return stopping;
  stopping = (async () => {
    console.log(`${signal} received. Stopping BGSNL background worker...`);
    await worker?.stop();
    await revenueWorker?.stop();
    stopAlertSchedule?.();
    await alertRun;
    await closeSpreadsheetSyncQueue();
    await closeMemberRevenueQueue();
    await mongoose.connection.close();
    console.log("BGSNL background worker stopped.");
  })();
  return stopping;
}

async function main() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(mongoUri());
  await JobFailureState.init();
  if ((process.env.GUEST_LIST_RECONCILIATION_ENABLED ?? (process.env.APP_ENV === "prod" ? "true" : "false")) === "true") {
    await scheduleGuestListReconciliation();
  }
  if (memberRevenueEnabled()) await scheduleMemberRevenueSweep();
  worker = startSpreadsheetSyncWorker();
  revenueWorker = startMemberRevenueWorker();
  stopAlertSchedule = startBusinessHourlyCheck(() => { void retryAlerts(); });
  console.log("BGSNL spreadsheet synchronization worker is running.");
}

process.once("SIGTERM", () => stop("SIGTERM").then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); }));
process.once("SIGINT", () => stop("SIGINT").then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); }));

main().catch(async (error) => {
  console.error("BGSNL background worker failed to start", error);
  await worker?.stop();
  await revenueWorker?.stop();
  stopAlertSchedule?.();
  await alertRun;
  await closeSpreadsheetSyncQueue();
  await closeMemberRevenueQueue();
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  process.exitCode = 1;
});
