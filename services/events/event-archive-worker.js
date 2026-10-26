import Event from "../../models/Event.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { runObservedJob } from "../monitoring/job-history.js";
import { archiveEvent, eventArchiveCutoff, expiredEventFilter } from "./archive-event.js";

const INTERVAL_MS = 60 * 1000;
const DAILY_HOUR_UTC = 3;
const DAILY_MINUTE_UTC = 15;

// eslint-disable-next-line no-process-env
export function eventArchiveEnabled(env = process.env) {
  return (env.NODE_APP_INSTANCE == null || env.NODE_APP_INSTANCE === "0") &&
    (env.EVENT_ARCHIVE_ENABLED === undefined
      ? env.NODE_ENV === "production"
      : env.EVENT_ARCHIVE_ENABLED === "true");
}

export async function archiveExpiredEventsSweep({ now = new Date(), EventModel = Event,
  archive = archiveEvent, onEventError = (error, eventId) =>
    logOperationalError("worker.event-archive-event", error, { eventId: String(eventId) }),
} = {}) {
  const cutoff = eventArchiveCutoff(now);
  let archived = 0, failed = 0;
  for await (const candidate of EventModel.find(expiredEventFilter(cutoff)).select("_id").cursor()) {
    try {
      if (await archive(candidate._id, { cutoff })) archived++;
    } catch (error) {
      failed++;
      onEventError(error, candidate._id);
    }
  }
  return { archived, failed, skipped: archived === 0 && failed === 0 };
}

export function createEventArchiveJob({ now = () => new Date(), sweep = archiveExpiredEventsSweep } = {}) {
  let completedDay;
  return async () => {
    const time = new Date(now());
    if (!Number.isFinite(time.getTime())) throw new Error("Invalid event archive time");
    const day = time.toISOString().slice(0, 10);
    if (time.getUTCHours() * 60 + time.getUTCMinutes() < DAILY_HOUR_UTC * 60 + DAILY_MINUTE_UTC ||
      completedDay === day) return { skipped: true };
    const result = await sweep({ now: time });
    // A failed event or query is retried at the next check; a successful day
    // is not repeated after the process stays up.
    if (!result.failed) completedDay = day;
    return result;
  };
}

export function startEventArchiveWorker({ enabled = eventArchiveEnabled(),
  run = createEventArchiveJob(), intervalMs = INTERVAL_MS, schedule = setInterval,
  unschedule = clearInterval, observe = runObservedJob,
  onError = error => logOperationalError("worker.event-archive", error),
} = {}) {
  if (!enabled) return async () => {};
  let stopped = false, running;
  const tick = () => {
    if (stopped || running) return;
    running = observe("scheduler", "event-archive", run)
      .catch(onError).finally(() => { running = null; });
  };
  const timer = schedule(tick, intervalMs);
  timer.unref?.();
  tick();
  return async () => { stopped = true; unschedule(timer); await running; };
}
