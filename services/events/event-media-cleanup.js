import { createHash } from "node:crypto";
import moment from "moment-timezone";
import Event from "../../models/Event.js";
import EventDraft from "../../models/EventDraft.js";
import { deleteFolder, deleteArchivedEventPoster } from "../../util/functions/cloudinary.js";
import { withBillingLease } from "../subscriptions/lease.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { runObservedJob } from "../monitoring/job-history.js";
import { ACADEMIC_YEAR_DATES, ACADEMIC_YEAR_TIME_ZONE } from "../../util/config/academic-year.js";
import { redisClient, redisPrefix } from "../storage/redis.js";

export const EVENT_MEDIA_TIME_ZONE = ACADEMIC_YEAR_TIME_ZONE;
export const POST_EVENT_MEDIA_GRACE_MS = 72 * 60 * 60 * 1000;
const BATCH_SIZE = 25;
const RETRY_MS = 60 * 60 * 1000;

const validDate = value => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid event media cleanup date");
  return date;
};
const folderId = folder => `folder:${createHash("sha256").update(folder).digest("hex")}`;

export function nextEventMediaCleanupAt(value, { includeBoundaryDay = false } = {}) {
  const date = validDate(value);
  const local = moment(date).tz(EVENT_MEDIA_TIME_ZONE);
  const due = moment.tz({ year: local.year(), month: ACADEMIC_YEAR_DATES.resetDate.month - 1, day: ACADEMIC_YEAR_DATES.resetDate.day,
    hour: 3, minute: 0, second: 0 }, EVENT_MEDIA_TIME_ZONE);
  if (due.isBefore(date) && !(includeBoundaryDay && local.month() === ACADEMIC_YEAR_DATES.resetDate.month - 1 &&
    local.date() === ACADEMIC_YEAR_DATES.resetDate.day)) due.add(1, "year");
  return due.toDate();
}

export function eventMediaCleanupDueAt(event, now = new Date()) {
  const time = validDate(now);
  const eventTime = validDate(event.correctedDate || event.date);
  const readyAt = new Date(eventTime.getTime() + POST_EVENT_MEDIA_GRACE_MS);
  return nextEventMediaCleanupAt(new Date(Math.max(time.getTime(), readyAt.getTime())), {
    includeBoundaryDay: readyAt <= time,
  });
}

export async function rememberDeletedDraftMedia(draft, { now = new Date(), DraftModel = EventDraft } = {}) {
  if (!draft?.folder) return null;
  if (!draft._id && !draft.id) throw new Error("Cannot track draft media without a draft ID");
  const dueAt = nextEventMediaCleanupAt(now, { includeBoundaryDay: true });
  const _id = draft._id || draft.id;
  await DraftModel.updateOne({ _id, deletedAt: null }, { $set: { deletedAt: validDate(now), mediaCleanupDueAt: dueAt } });
  return { _id, dueAt };
}

export function getEventMediaCleanupConfig(env = process.env) {
  return { enabled: (env.NODE_APP_INSTANCE == null || env.NODE_APP_INSTANCE === "0") &&
    (env.EVENT_MEDIA_CLEANUP_ENABLED === undefined ? env.NODE_ENV === "production" : env.EVENT_MEDIA_CLEANUP_ENABLED === "true") };
}

export async function runEventMediaCleanup({ now = new Date(), cutoff = now, EventModel = Event, DraftModel = EventDraft,
  removeFolder = deleteFolder, removeArchivedPoster = deleteArchivedEventPoster,
  lease = withBillingLease } = {}) {
  const time = validDate(now);
  const annualCutoff = validDate(cutoff);
  const unscheduled = await EventModel.find({ folder: { $type: "string", $ne: "" }, mediaCleanupAt: null, mediaCleanupDueAt: null })
    .select("_id date correctedDate folder").limit(BATCH_SIZE).lean();
  for (const event of unscheduled) {
    const dueAt = eventMediaCleanupDueAt(event, annualCutoff);
    await EventModel.updateOne({ _id: event._id, mediaCleanupDueAt: null }, { $set: { mediaCleanupDueAt: dueAt } });
  }

  const ready = { $lte: annualCutoff };
  const [events, deletedDrafts] = await Promise.all([
    EventModel.find({ folder: { $type: "string", $ne: "" }, mediaCleanupDueAt: ready, mediaCleanupAt: null,
      $or: [{ mediaCleanupRetryAt: null }, { mediaCleanupRetryAt: ready }] })
      .select("_id folder mediaCleanupDueAt").limit(BATCH_SIZE).lean(),
    DraftModel.find({ deletedAt: { $ne: null }, folder: { $type: "string", $ne: "" }, mediaCleanupDueAt: ready,
      $or: [{ mediaCleanupRetryAt: null }, { mediaCleanupRetryAt: ready }] })
      .select("_id folder mediaCleanupDueAt").limit(BATCH_SIZE).lean(),
  ]);
  const folders = [...new Set([...events, ...deletedDrafts].map(item => item.folder).filter(Boolean))].slice(0, BATCH_SIZE);
  if (!folders.length) return { skipped: !unscheduled.length, scheduled: unscheduled.length, cleared: 0, deferred: 0, failed: 0 };

  let cleared = 0, deferred = 0, failed = 0;
  for (const folder of folders) {
    try {
      const result = await lease(`event-media:${folderId(folder)}`, async ({ assertOwned }) => {
        const dueDates = [
          ...events.filter(event => event.folder === folder).map(event => event.mediaCleanupDueAt),
          ...deletedDrafts.filter(draft => draft.folder === folder).map(draft => draft.mediaCleanupDueAt),
        ];
        const cutoff = new Date(Math.min(...dueDates.map(date => new Date(date).getTime())));
        if (!Number.isFinite(cutoff.getTime())) throw new Error("Invalid event media cleanup cutoff");
        const [references, activeDraft] = await Promise.all([
          EventModel.find({ folder }).select("_id date correctedDate poster mediaCleanupDueAt mediaCleanupAt").lean(),
          DraftModel.exists({ folder, deletedAt: null }),
        ]);
        const blocked = Boolean(activeDraft) || references.some(event => {
          if (event.mediaCleanupAt) return false;
          const eventTime = new Date(event.correctedDate || event.date).getTime();
          return !Number.isFinite(eventTime) || eventTime + POST_EVENT_MEDIA_GRACE_MS > cutoff.getTime() ||
            (event.mediaCleanupDueAt && new Date(event.mediaCleanupDueAt) > cutoff);
        });
        if (blocked) {
          const nextDue = nextEventMediaCleanupAt(new Date(cutoff.getTime() + 24 * 60 * 60 * 1000));
          await EventModel.updateMany({ folder, mediaCleanupAt: null, mediaCleanupDueAt: { $lte: cutoff } },
            { $set: { mediaCleanupDueAt: nextDue }, $unset: { mediaCleanupRetryAt: 1 } });
          await DraftModel.updateMany({ folder, deletedAt: { $ne: null }, mediaCleanupDueAt: { $lte: cutoff } },
            { $set: { mediaCleanupDueAt: nextDue }, $unset: { mediaCleanupRetryAt: 1 } });
          return "deferred";
        }
        await assertOwned();
        await removeFolder(folder);
        for (const event of references) await removeArchivedPoster(event);
        await assertOwned();
        await EventModel.updateMany({ folder, mediaCleanupAt: null }, { $set: { mediaCleanupAt: time }, $unset: { mediaCleanupRetryAt: 1 } });
        await DraftModel.deleteMany({ folder, deletedAt: { $ne: null } });
        return "cleared";
      });
      if (result === "cleared") cleared++;
      else if (result === "deferred") deferred++;
    } catch (error) {
      failed++;
      const retryAt = new Date(time.getTime() + RETRY_MS);
      await Promise.all([
        EventModel.updateMany({ folder, mediaCleanupAt: null }, { $set: { mediaCleanupRetryAt: retryAt } }),
        DraftModel.updateMany({ folder, deletedAt: { $ne: null } }, { $set: { mediaCleanupRetryAt: retryAt } }),
      ]);
      logOperationalError("worker.event-media-cleanup", error);
    }
  }
  return { scheduled: unscheduled.length, cleared, deferred, failed };
}

export async function runAnnualEventMediaCleanup({ now = new Date(), cutoff, run = runEventMediaCleanup,
  EventModel = Event, DraftModel = EventDraft } = {}) {
  let scheduled = 0, cleared = 0, deferred = 0;
  for (let batch = 0; batch < 1000; batch++) {
    const result = await run({ now, cutoff, EventModel, DraftModel });
    scheduled += result.scheduled || 0;
    cleared += result.cleared || 0;
    deferred += result.deferred || 0;
    if (result.failed) return { scheduled, cleared, deferred, failed: result.failed };
    if (!result.scheduled && !result.cleared && !result.deferred) {
      const ready = { $lte: cutoff };
      const [events, drafts] = await Promise.all([
        EventModel.countDocuments({ folder: { $type: "string", $ne: "" }, mediaCleanupDueAt: ready, mediaCleanupAt: null }),
        DraftModel.countDocuments({ deletedAt: { $ne: null }, folder: { $type: "string", $ne: "" }, mediaCleanupDueAt: ready }),
      ]);
      return { scheduled, cleared, deferred, failed: 0, pendingRetry: events + drafts };
    }
  }
  throw new Error("Annual event media cleanup exceeded its batch limit");
}

export function createAnnualEventMediaCleanupJob({ now = () => new Date(), sweep = runAnnualEventMediaCleanup,
  getMarker = async key => (await redisClient()).get(key),
  setMarker = async key => (await redisClient()).set(key, "complete", { EX: 400 * 86400 }) } = {}) {
  return async () => {
    const time = validDate(now());
    const local = moment(time).tz(EVENT_MEDIA_TIME_ZONE);
    const cutoff = moment.tz({ year: local.year(), month: ACADEMIC_YEAR_DATES.resetDate.month - 1,
      day: ACADEMIC_YEAR_DATES.resetDate.day, hour: 3, minute: 0, second: 0 }, EVENT_MEDIA_TIME_ZONE).toDate();
    if (time < cutoff) return { skipped: true };
    const key = `${redisPrefix()}annual-event-media-cleanup:${local.year()}`;
    if (await getMarker(key)) return { skipped: true };
    const result = await sweep({ now: time, cutoff });
    if (!result.failed && !result.pendingRetry) await setMarker(key);
    return result.pendingRetry ? { ...result, skipped: true } : result;
  };
}

export function startEventMediaCleanupWorker({ config = getEventMediaCleanupConfig(),
  run = createAnnualEventMediaCleanupJob(), intervalMs = 60 * 1000, schedule = setInterval, unschedule = clearInterval,
  onError = error => { logOperationalError("worker.event-media-cleanup", error); console.error("Event media cleanup failed; retrying on the next tick"); },
} = {}) {
  if (!config.enabled) return async () => {};
  let stopped = false, running;
  const tick = () => {
    if (stopped || running) return;
    running = runObservedJob("scheduler", "event-media-cleanup", run).catch(onError).finally(() => { running = null; });
  };
  const timer = schedule(tick, intervalMs);
  timer.unref?.();
  tick();
  return async () => { stopped = true; unschedule(timer); await running; };
}
