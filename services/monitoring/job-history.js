import MonitoringJob from "../../models/MonitoringJob.js";
import { describeError, logOperationalError } from "../../middleware/axiom-logger.js";

export const JOB_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const safeName = (value) => typeof value === "string" && /^[a-z][a-z0-9-]{0,49}$/.test(value) ? value : "unknown";
export const jobNameFromKey = (key) => safeName(String(key || "").split(":")[0]
  .replace(/([a-z\d])([A-Z])/g, "$1-$2").toLowerCase());

export const observeJob = (source, name, { model = MonitoringJob, now = () => new Date() } = {}) => {
  if (model === MonitoringJob && model.db.readyState !== 1) {
    return { start() {}, complete() {}, fail() {}, discard() {} };
  }
  const createdAt = now();
  const record = Promise.resolve().then(() => model.create({ source, name: safeName(name), status: "pending", attempts: 0,
    createdAt, activityAt: createdAt, expiresAt: new Date(+createdAt + JOB_HISTORY_RETENTION_MS) })).catch((error) => {
    logOperationalError("service.job-history-create", error);
    return null;
  });
  let writes = record;
  const write = (operation) => {
    writes = writes.then(async (document) => { if (document) await operation(document); return document; })
      .catch(async (error) => { logOperationalError("service.job-history-update", error); return record; });
    return writes;
  };
  const update = (patch) => write((document) => model.updateOne({ _id: document._id }, { $set: patch }));
  return {
    start: () => { const startedAt = now(); update({ status: "pending", attempts: 1, startedAt, activityAt: startedAt }); },
    complete: () => { const finishedAt = now(); return update({ status: "completed", finishedAt, activityAt: finishedAt,
      expiresAt: new Date(+finishedAt + JOB_HISTORY_RETENTION_MS) }); },
    fail: (error) => { const descriptor = describeError(error); const finishedAt = now();
      return update({ status: "failed", finishedAt, activityAt: finishedAt, errorName: descriptor.name,
        expiresAt: new Date(+finishedAt + JOB_HISTORY_RETENTION_MS) }); },
    discard: () => write((document) => model.deleteOne({ _id: document._id })),
  };
};

export const runObservedJob = async (source, name, work, { observe = observeJob, failurePolicy } = {}) => {
  const policy = failurePolicy || (await import("./job-failure-policy.js")).jobFailurePolicy;
  if (!await policy.canRun(source, name)) return { status: "halted", skipped: true };
  const record = observe(source, name);
  record.start();
  try {
    const result = await work();
    if (result?.skipped === true || result?.noWork === true || ["not-due", "disabled", "already-processed"].includes(result?.status)) await record.discard();
    else if (result?.failed > 0 || result?.status === "delivery-failed" || result?.success === false) {
      await record.fail(new Error("Job failed"));
      await policy.failure(source, name);
    } else {
      await record.complete();
      await policy.success(source, name);
    }
    return result;
  } catch (error) {
    await record.fail(error);
    await policy.failure(source, name);
    throw error;
  }
};
