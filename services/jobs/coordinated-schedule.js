import { redisRecordStore } from "../storage/redis-records.js";
import { withBillingLease } from "../subscriptions/lease.js";
import { runObservedJob } from "../monitoring/job-history.js";
import { isBusyLease, recoveryDelay } from "./recovery-backoff.js";

const schedules = redisRecordStore("scheduled-job", { ttlMs: 7 * 86400_000 });

// A lease prevents overlapping work; a persisted due time also prevents the
// second process from running the same sweep immediately after the first ends.
export async function runCoordinatedSchedule(name, work, {
  intervalMs = 60_000, records = schedules, withLease = withBillingLease,
  observe = runObservedJob, now = Date.now,
} = {}) {
  const key = `scheduler:${name}`;
  let entered = false;
  try {
    return await withLease(key, async ({ record, assertOwned }) => {
      entered = true;
      if (+new Date(record.nextRunAt) > now()) return { skipped: true };
      const save = async patch => {
        await assertOwned();
        await records.updateOne({ _id: key }, { $set: patch }, { upsert: true });
      };
      await save({ nextRunAt: new Date(now() + intervalMs) });
      return observe("scheduler", name, async () => {
        try {
          const result = await work({ assertOwned });
          await save({ failures: 0, nextRunAt: new Date(now() + intervalMs) });
          return result;
        } catch (error) {
          const failures = (record.failures || 0) + 1;
          await save({ failures, nextRunAt: new Date(now() + recoveryDelay(failures, error)) });
          throw error;
        }
      });
    }, { records });
  } catch (error) {
    // Only failure to acquire our coordinator is a harmless skip. Errors from
    // inside the work, including unexpected business conflicts, stay visible.
    if (!entered && isBusyLease(error)) return { skipped: true };
    throw error;
  }
}
