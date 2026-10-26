import moment from "moment-timezone";
import MonitoringJob from "../../models/MonitoringJob.js";
import JobFailureState from "../../models/JobFailureState.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { runObservedJob, JOB_HISTORY_RETENTION_MS } from "../monitoring/job-history.js";
import { getSpreadsheetSyncQueue } from "../jobs/spreadsheet-sync-queue.js";
import { getMarketingCaptureQueue } from "../jobs/marketing-capture-queue.js";
import { getMemberRevenueQueue } from "../subscriptions/member-revenue-queue.js";
import { pruneMigrationJournal } from "../migrations/journal-retention.js";

export const LOG_RETENTION_TIME_ZONE = "Europe/Amsterdam";
const BATCH_SIZE = 1000;
const MAX_BATCHES = 100;

export function getLogRetentionConfig(env = process.env) {
  return { enabled: (env.NODE_APP_INSTANCE == null || env.NODE_APP_INSTANCE === "0") &&
    (env.LOG_RETENTION_ENABLED === undefined ? env.NODE_ENV === "production" : env.LOG_RETENTION_ENABLED === "true") };
}

async function cleanQueue(queue, ageMs = JOB_HISTORY_RETENTION_MS) {
  let removed = 0;
  for (const status of ["completed", "failed"]) {
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const ids = await queue.clean(ageMs, BATCH_SIZE, status);
      removed += ids.length;
      if (ids.length < BATCH_SIZE) break;
      if (batch === MAX_BATCHES - 1) throw new Error("Job retention cleanup exceeded its batch limit");
    }
  }
  return removed;
}

export async function runLogRetention({ now = new Date(), model = MonitoringJob, failureModel = JobFailureState,
  cleanJournal = pruneMigrationJournal, spreadsheetQueue = getSpreadsheetSyncQueue,
  marketingQueue = getMarketingCaptureQueue, revenueQueue = getMemberRevenueQueue } = {}) {
  const time = new Date(now);
  if (!Number.isFinite(+time)) throw new Error("Invalid log retention time");
  const cutoff = new Date(+time - JOB_HISTORY_RETENTION_MS);
  const [journal, history, alerts, spreadsheetJobs, marketingJobs, revenueJobs] = await Promise.all([
    cleanJournal({ now: time }),
    model.deleteMany({ $or: [{ expiresAt: { $lte: time } },
      { expiresAt: null, activityAt: { $lt: cutoff } }] }),
    failureModel.deleteMany({ source: { $ne: "scheduler" }, alertedAt: { $lt: cutoff } }),
    cleanQueue(spreadsheetQueue()),
    cleanQueue(marketingQueue()),
    cleanQueue(revenueQueue()),
  ]);
  return { journal, historyDeleted: history.deletedCount, alertsDeleted: alerts.deletedCount,
    spreadsheetJobs, marketingJobs, revenueJobs };
}

export function createLogRetentionJob({ now = () => new Date(), cleanup = runLogRetention } = {}) {
  let completedDay;
  return async () => {
    const time = new Date(now());
    const local = moment(time).tz(LOG_RETENTION_TIME_ZONE);
    if (!local.isValid()) throw new Error("Invalid log retention time");
    const day = local.format("YYYY-MM-DD");
    if (local.hour() < 3 || local.hour() === 3 && local.minute() < 5 || completedDay === day) return { skipped: true };
    const result = await cleanup({ now: time });
    completedDay = day;
    return result;
  };
}

export function startLogRetentionWorker({ config = getLogRetentionConfig(), run = createLogRetentionJob(),
  intervalMs = 60_000, schedule = setInterval, unschedule = clearInterval,
  onError = error => logOperationalError("worker.log-retention", error) } = {}) {
  if (!config.enabled) return async () => {};
  let stopped = false, running;
  const tick = () => {
    if (stopped || running) return;
    running = runObservedJob("scheduler", "log-retention", run).catch(onError).finally(() => { running = null; });
  };
  const timer = schedule(tick, intervalMs);
  timer.unref?.();
  tick();
  return async () => { stopped = true; unschedule(timer); await running; };
}
