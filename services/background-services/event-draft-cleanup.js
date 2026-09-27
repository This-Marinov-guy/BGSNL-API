import moment from "moment-timezone";
import EventDraft from "../../models/EventDraft.js";
import { EVENT_DRAFT } from "../../util/config/defines.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { runObservedJob } from "../monitoring/job-history.js";

export const EVENT_DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const EVENT_DRAFT_CLEANUP_TIME_ZONE = "Europe/Amsterdam";

export function getEventDraftCleanupConfig(env = process.env) {
  return {
    enabled: (env.NODE_APP_INSTANCE == null || env.NODE_APP_INSTANCE === "0") &&
      (env.EVENT_DRAFT_CLEANUP_ENABLED === undefined
        ? env.NODE_ENV === "production"
        : env.EVENT_DRAFT_CLEANUP_ENABLED === "true"),
  };
}

export async function deleteExpiredEventDrafts({ now = new Date(), DraftModel = EventDraft } = {}) {
  const timestamp = new Date(now).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("Invalid event draft cleanup time");
  const cutoff = new Date(timestamp - EVENT_DRAFT_RETENTION_MS);
  // The age is based on creation, not the last edit. Legacy drafts may only
  // have their creation date in metadata. Undated records are not guessed.
  const result = await DraftModel.deleteMany({
    status: EVENT_DRAFT,
    $or: [
      { createdAt: { $type: "date", $lt: cutoff } },
      { createdAt: null, "metadata.createdAt": { $type: "date", $lt: cutoff } },
    ],
  });
  return { deletedCount: result.deletedCount, cutoff };
}

export function createEventDraftCleanupJob({
  now = () => new Date(), cleanup = deleteExpiredEventDrafts,
} = {}) {
  let completedDay;
  return async () => {
    const timestamp = new Date(now());
    const local = moment(timestamp).tz(EVENT_DRAFT_CLEANUP_TIME_ZONE);
    if (!local.isValid()) throw new Error("Invalid event draft cleanup time");
    const dateKey = local.format("YYYY-MM-DD");
    if (local.hour() < 3 || completedDay === dateKey) return { skipped: true };
    const result = await cleanup({ now: timestamp });
    // Retry failures on the next tick; successful runs need no durable logs.
    completedDay = dateKey;
    return result;
  };
}

export function startEventDraftCleanupWorker({
  config = getEventDraftCleanupConfig(),
  run = createEventDraftCleanupJob(),
  intervalMs = 60 * 1000,
  schedule = setInterval,
  unschedule = clearInterval,
  onError = (error) => { logOperationalError("worker.event-draft-cleanup", error); console.error("Event draft cleanup failed; retrying on the next tick"); },
} = {}) {
  if (!config.enabled) return async () => {};
  let stopped = false;
  let running;
  const tick = () => {
    if (stopped || running) return;
    running = runObservedJob("scheduler", "event-draft-cleanup", run).catch(onError).finally(() => { running = null; });
  };
  const timer = schedule(tick, intervalMs);
  timer.unref?.();
  tick();
  return async () => {
    stopped = true;
    unschedule(timer);
    await running;
  };
}
