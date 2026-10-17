import { redisRecordStore } from "../storage/redis-records.js";
import { withBillingLease } from "../subscriptions/lease.js";
import { runObservedJob } from "../monitoring/job-history.js";
import { isBusyLease, recoveryDelay } from "./recovery-backoff.js";

const schedules = redisRecordStore("scheduled-job", { ttlMs: 7 * 86400_000 });

// A webhook can request an early pass without running Stripe reconciliation in
// the HTTP request. The counter also preserves a wake arriving during a pass.
export async function requestCoordinatedSchedule(name, { records = schedules, reason } = {}) {
  await records.updateOne({ _id: `scheduler:${name}` }, { $inc: { wakeCount: 1, ...(reason === "balance" ? { balanceWakeCount: 1 } : {}) } }, { upsert: true });
}

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
      const wakeCount = record.wakeCount || 0;
      const balanceWakeCount = record.balanceWakeCount || 0;
      if (+new Date(record.nextRunAt) > now() && wakeCount <= (record.handledWakeCount || 0)) return { skipped: true };
      const save = async patch => {
        await assertOwned();
        await records.updateOne({ _id: key }, { $set: patch }, { upsert: true });
      };
      await save({ nextRunAt: new Date(now() + intervalMs) });
      return observe("scheduler", name, async () => {
        try {
          const result = await work({ assertOwned, woken: wakeCount > (record.handledWakeCount || 0),
            balanceWoken: balanceWakeCount > (record.handledBalanceWakeCount || 0) });
          await save({ failures: 0, handledWakeCount: wakeCount, handledBalanceWakeCount: balanceWakeCount, nextRunAt: new Date(now() + intervalMs) });
          return result;
        } catch (error) {
          const failures = (record.failures || 0) + 1;
          await save({ failures, handledWakeCount: wakeCount, handledBalanceWakeCount: balanceWakeCount,
            nextRunAt: new Date(now() + recoveryDelay(failures, error)) });
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
