import { getSpreadsheetSyncQueue, SPREADSHEET_SYNC_QUEUE } from "../jobs/spreadsheet-sync-queue.js";
import { getMarketingCaptureQueue, MARKETING_CAPTURE_QUEUE } from "../jobs/marketing-capture-queue.js";
import MonitoringJob from "../../models/MonitoringJob.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";

// BullMQ's public "waiting" alias also includes paused jobs. Use the Redis
// "wait" state here so paused jobs are counted and listed exactly once.
const PENDING_STATES = ["active", "wait", "delayed", "paused", "prioritized", "waiting-children"];
const ALL_STATES = ["failed", ...PENDING_STATES, "completed"];
const JOB_NAMES = new Set(["event", "special-event", "members", "alumni", "internships", "reconcile-guest-lists", MARKETING_CAPTURE_QUEUE]);
const PAGE_SIZE = 20;
const MAX_PAGE = 50;
const READ_TIMEOUT_MS = 3000;

const withTimeout = async (operation) => {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Job queue read timed out")), READ_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
};

export const normalizeJobFilter = (status, page) => {
  const selected = status === undefined ? "all" : status;
  if (!["all", "failed", "pending", "completed"].includes(selected)) return null;
  const number = page === undefined ? 1 : Number(page);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_PAGE) return null;
  return { status: selected, page: number };
};

const summaryFromCounts = (counts) => ({
  failed: counts.failed || 0,
  pending: PENDING_STATES.reduce((sum, state) => sum + (counts[state] || 0), 0),
  completed: counts.completed || 0,
});
const emptyCounts = () => ({ failed: 0, pending: 0, completed: 0 });
const addCounts = (first, second) => ({ failed: first.failed + second.failed,
  pending: first.pending + second.pending, completed: first.completed + second.completed });
const totalFor = (counts, status) => status === "all" ? counts.failed + counts.pending + counts.completed : counts[status];

const safeTime = (value) => Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
const safeNumber = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export const serializeJob = (job, state, source = SPREADSHEET_SYNC_QUEUE) => ({
  id: typeof job.id === "string" && /^\d{1,20}$/.test(job.id) ? job.id : null,
  name: JOB_NAMES.has(job.name) ? job.name : "unknown",
  source,
  status: state === "failed" || state === "completed" ? state : "pending",
  state: state === "wait" ? "waiting" : state,
  attempts: safeNumber(job.attemptsMade),
  maxAttempts: safeNumber(job.opts?.attempts),
  createdAt: safeTime(job.timestamp),
  startedAt: safeTime(job.processedOn),
  finishedAt: safeTime(job.finishedOn),
  activityAt: safeTime(job.finishedOn || job.processedOn || job.timestamp),
  errorName: null,
});

const serializeHistoryJob = (job) => ({
  id: /^[a-f\d]{24}$/i.test(String(job._id || "")) ? String(job._id) : null,
  name: typeof job.name === "string" && /^[a-z][a-z0-9-]{0,49}$/.test(job.name) ? job.name : "unknown",
  source: ["scheduler", "mailer", "sheets-inline"].includes(job.source) ? job.source : "unknown",
  status: ["failed", "pending", "completed"].includes(job.status) ? job.status : "pending",
  state: job.status,
  attempts: safeNumber(job.attempts), maxAttempts: 1,
  createdAt: job.createdAt instanceof Date && !Number.isNaN(+job.createdAt) ? job.createdAt.toISOString() : null,
  startedAt: job.startedAt instanceof Date && !Number.isNaN(+job.startedAt) ? job.startedAt.toISOString() : null,
  finishedAt: job.finishedAt instanceof Date && !Number.isNaN(+job.finishedAt) ? job.finishedAt.toISOString() : null,
  activityAt: [job.activityAt, job.finishedAt, job.startedAt, job.createdAt].find((value) => value instanceof Date && !Number.isNaN(+value))?.toISOString() || null,
  errorName: typeof job.errorName === "string" && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(job.errorName) ? job.errorName : null,
});

const historyFilter = (status) => ({ expiresAt: { $gt: new Date() },
  ...(status === "all" ? {} : { status }) });
const readHistoryCounts = async (model) => {
  if (model === MonitoringJob && model.db.readyState !== 1) throw new Error("Job history database unavailable");
  const [failed, pending, completed] = await withTimeout(Promise.all(["failed", "pending", "completed"]
    .map((status) => model.countDocuments(historyFilter(status)))));
  return { failed, pending, completed };
};
const readQueueCounts = async (getQueue) => summaryFromCounts(await withTimeout(getQueue().getJobCounts(...ALL_STATES)));
const sourcesFromResults = (queue, history, marketing) => ({ spreadsheetSync: queue.status === "fulfilled", history: history.status === "fulfilled",
  marketingCapture: marketing.status === "fulfilled" });
const reportFailures = (queue, history, marketing) => {
  if (queue.status === "rejected") logOperationalError("service.monitoring-spreadsheet-jobs", queue.reason);
  if (history.status === "rejected") logOperationalError("service.monitoring-job-history", history.reason);
  if (marketing.status === "rejected") logOperationalError("service.monitoring-marketing-jobs", marketing.reason);
};

export async function jobSummary({ getQueue = getSpreadsheetSyncQueue, model = MonitoringJob,
  getMarketingQueue = getMarketingCaptureQueue } = {}) {
  const results = await Promise.allSettled([readQueueCounts(getQueue), readHistoryCounts(model), readQueueCounts(getMarketingQueue)]);
  reportFailures(...results);
  if (results.every((result) => result.status === "rejected")) throw new Error("Job sources unavailable");
  return { available: true, sources: sourcesFromResults(...results),
    counts: results.reduce((counts, result) => addCounts(counts, result.status === "fulfilled" ? result.value : emptyCounts()), emptyCounts()) };
}

const readQueuePage = async (getQueue, status, limit, source = SPREADSHEET_SYNC_QUEUE) => {
  const queue = getQueue();
  const states = status === "all" ? ALL_STATES : status === "pending" ? PENDING_STATES : [status];
  const [counts, groups] = await withTimeout(Promise.all([
    queue.getJobCounts(...ALL_STATES),
    Promise.all(states.map(async (state) => ({ state, jobs: await queue.getJobs([state], 0, limit - 1, false) }))),
  ]));
  return { counts: summaryFromCounts(counts), items: groups.flatMap(({ state, jobs }) => jobs.map((job) => serializeJob(job, state, source))) };
};

const readHistoryPage = async (model, status, limit) => {
  const counts = await readHistoryCounts(model);
  const records = await withTimeout(model.find(historyFilter(status)).sort({ activityAt: -1 }).limit(limit).lean());
  return { counts, items: records.map(serializeHistoryJob) };
};

export async function listJobs({ status = "all", page = 1, getQueue = getSpreadsheetSyncQueue, model = MonitoringJob,
  getMarketingQueue = getMarketingCaptureQueue } = {}) {
  const filter = normalizeJobFilter(status, page);
  if (!filter) throw new RangeError("Invalid job filter");
  const offset = (page - 1) * PAGE_SIZE;
  const results = await Promise.allSettled([readQueuePage(getQueue, status, offset + PAGE_SIZE),
    readHistoryPage(model, status, offset + PAGE_SIZE),
    readQueuePage(getMarketingQueue, status, offset + PAGE_SIZE, MARKETING_CAPTURE_QUEUE)]);
  reportFailures(...results);
  if (results.every((result) => result.status === "rejected")) throw new Error("Job sources unavailable");
  const summary = results.reduce((counts, result) => addCounts(counts,
    result.status === "fulfilled" ? result.value.counts : emptyCounts()), emptyCounts());
  const total = totalFor(summary, status);
  const items = results.flatMap((result) => result.status === "fulfilled" ? result.value.items : [])
    .sort((a, b) => (Date.parse(b.activityAt) || 0) - (Date.parse(a.activityAt) || 0))
    .slice(offset, offset + PAGE_SIZE);
  return { available: true, sources: sourcesFromResults(...results), status, page, pageSize: PAGE_SIZE,
    total, hasMore: page < MAX_PAGE && offset + items.length < total, counts: summary, items };
}
