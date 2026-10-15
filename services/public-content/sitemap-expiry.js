import Event from "../../models/Event.js";
import { DEFAULT_REGION } from "../../util/config/defines.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { runObservedJob } from "../monitoring/job-history.js";
import { isEmailSchedulerProcess } from "../background-services/email-run-guard.js";
import { FUTURE_EVENT_GRACE_MS, publicEventQuery } from "./event-publication.js";
import { dispatchSitemapRefresh } from "./sitemap-dispatch.js";

const BATCH_SIZE = 100;
const effectiveDate = { $ifNull: ["$correctedDate", "$date"] };

export function pastSitemapEventFilter(now = new Date()) {
  const timestamp = new Date(now).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("Invalid sitemap expiry time");
  return {
    ...publicEventQuery,
    region: { $ne: DEFAULT_REGION },
    $expr: { $and: [
      { $eq: [{ $type: effectiveDate }, "date"] },
      { $lte: [effectiveDate, new Date(timestamp - FUTURE_EVENT_GRACE_MS)] },
      { $ne: ["$sitemapPastRefreshedFor", effectiveDate] },
    ] },
  };
}

export async function refreshPastEventSitemap({ now = new Date(), EventModel = Event,
  refresh = dispatchSitemapRefresh } = {}) {
  const events = await EventModel.find(pastSitemapEventFilter(now))
    .select("_id date correctedDate region slug").limit(BATCH_SIZE).lean();
  if (!events.length) return { skipped: true, expired: 0, refreshed: false };
  // One sitemap refresh covers the whole batch. Persist a marker only after
  // GitHub accepts the dispatch; a failure leaves every event eligible to retry.
  if (!await refresh("past", events[0])) throw new Error("Past-event sitemap refresh was not accepted");
  for (const event of events) {
    const date = event.correctedDate || event.date;
    await EventModel.updateOne({ _id: event._id,
      ...(event.correctedDate ? { correctedDate: event.correctedDate } : { correctedDate: null, date: event.date }),
    }, { $set: { sitemapPastRefreshedFor: date } });
  }
  return { expired: events.length, refreshed: true };
}

// eslint-disable-next-line no-process-env
export const eventSitemapExpiryEnabled = (env = process.env) =>
  isEmailSchedulerProcess(env) && (env.EVENT_SITEMAP_EXPIRY_ENABLED === undefined
    ? env.NODE_ENV === "production" : env.EVENT_SITEMAP_EXPIRY_ENABLED === "true") &&
  Boolean(env.GITHUB_SITEMAP_REPOSITORY && env.GITHUB_SITEMAP_DISPATCH_TOKEN);

export function startEventSitemapExpiryWorker({ enabled = eventSitemapExpiryEnabled(),
  run = refreshPastEventSitemap, intervalMs = 60_000, schedule = setInterval,
  unschedule = clearInterval, onError = error => logOperationalError("worker.event-sitemap-expiry", error),
} = {}) {
  if (!enabled) return async () => {};
  let stopped = false, running;
  const tick = () => {
    if (stopped || running) return;
    running = runObservedJob("scheduler", "event-sitemap-expiry", run)
      .catch(onError).finally(() => { running = null; });
  };
  const timer = schedule(tick, intervalMs);
  timer.unref?.();
  tick();
  return async () => { stopped = true; unschedule(timer); await running; };
}
