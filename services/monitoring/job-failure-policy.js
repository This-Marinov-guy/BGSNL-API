import JobFailureState from "../../models/JobFailureState.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { sendDeveloperJobAlert } from "../background-services/developer-notifications.js";

export const MAX_JOB_FAILURES = 5;
const ALERT_LEASE_MS = 5 * 60_000;
const keyFor = (source, name) => `${source}:${name}`;

export function createJobFailurePolicy({ model = JobFailureState, notify = sendDeveloperJobAlert,
  maxFailures = MAX_JOB_FAILURES, now = () => new Date() } = {}) {
  const available = () => model !== JobFailureState || model.db.readyState === 1;
  const alert = async (key) => {
    if (!available()) return;
    const time = now();
    const until = new Date(+time + ALERT_LEASE_MS);
    const state = await model.findOneAndUpdate({ _id: key, haltedAt: { $ne: null }, alertedAt: null,
      $or: [{ alertLeaseUntil: null }, { alertLeaseUntil: { $lte: time } }] },
    { $set: { alertLeaseUntil: until } }, { new: true }).lean();
    if (!state) return;
    try {
      const source = state.source || key.split(":")[0];
      const name = state.name || key.split(":")[1];
      const sent = await notify({ source, name, attempts: state.failures, stoppedAt: state.haltedAt });
      if (!sent) throw new Error("Developer job alert was not queued");
      await model.updateOne({ _id: state._id, alertLeaseUntil: until },
        { $set: { alertedAt: now() }, $unset: { alertLeaseUntil: 1 } });
    } catch (error) {
      await model.updateOne({ _id: state._id, alertLeaseUntil: until }, { $unset: { alertLeaseUntil: 1 } });
      logOperationalError("service.job-failure-alert", error);
    }
  };
  return {
    async canRun(source, name) {
      if (source !== "scheduler") return true;
      if (!available()) return false;
      try {
        const state = await model.findById(keyFor(source, name)).lean();
        if (!state?.haltedAt) return true;
        return false;
      } catch (error) {
        logOperationalError("service.job-failure-gate", error);
        return false;
      }
    },
    async success(source, name) {
      if (source !== "scheduler" || !available()) return;
      try {
        await model.updateOne({ _id: keyFor(source, name) },
          { $set: { failures: 0, source, name, updatedAt: now() },
            $unset: { haltedAt: 1, alertedAt: 1, alertLeaseUntil: 1 } });
      } catch (error) { logOperationalError("service.job-failure-reset", error); }
    },
    async failure(source, name) {
      if (source !== "scheduler" || !available()) return;
      try {
        const state = await model.findOneAndUpdate({ _id: keyFor(source, name) },
          { $inc: { failures: 1 }, $set: { source, name, updatedAt: now() } }, { new: true, upsert: true }).lean();
        if (state.failures >= maxFailures) {
          await model.updateOne({ _id: state._id, haltedAt: null }, { $set: { haltedAt: now() } });
          await alert(keyFor(source, name));
        }
      } catch (error) { logOperationalError("service.job-failure-count", error); }
    },
    async queueFailure(source, name, jobId, attempts) {
      if (!available() || jobId == null) return;
      try {
        const key = `queue:${source}:${jobId}`;
        const time = now();
        await model.updateOne({ _id: key }, { $setOnInsert: { source, name,
          failures: attempts, haltedAt: time, updatedAt: time } }, { upsert: true });
        await alert(key);
      } catch (error) { logOperationalError("service.queue-failure-alert", error); }
    },
    async retryAlerts() {
      if (!available()) return;
      try {
        const time = now();
        const states = await model.find({ haltedAt: { $ne: null }, alertedAt: null,
          $or: [{ alertLeaseUntil: null }, { alertLeaseUntil: { $lte: time } }] })
          .limit(100).lean();
        for (const state of states) await alert(state._id);
      } catch (error) { logOperationalError("service.job-failure-alert-retry", error); }
    },
  };
}

export const jobFailurePolicy = createJobFailurePolicy();
