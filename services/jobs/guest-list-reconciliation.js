import Event from "../../models/Event.js";
import NonSocietyEvent from "../../models/NonSocietyEvent.js";
import { enqueueSpreadsheetSync, getSpreadsheetSyncQueue } from "./spreadsheet-sync-queue.js";

export const GUEST_LIST_RECONCILIATION_JOB = "reconcile-guest-lists";
export const GUEST_LIST_RECONCILIATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_EVENTS_PER_RUN = 500;
const RECENT_DAYS = 30;

export async function reconcileGuestLists({
  eventModel = Event,
  specialEventModel = NonSocietyEvent,
  enqueue = enqueueSpreadsheetSync,
  now = new Date(),
} = {}) {
  const cutoff = new Date(now.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const filter = { "guestList.0": { $exists: true }, status: { $ne: "draft" } };
  const [events, specialEvents] = await Promise.all([
    eventModel.find({ ...filter, sheetName: { $type: "string", $ne: "" },
      $or: [{ date: { $gte: cutoff } }, { correctedDate: { $gte: cutoff } }] })
      .select("_id").limit(MAX_EVENTS_PER_RUN + 1).lean(),
    specialEventModel.find({ ...filter, date: { $gte: cutoff } }).select("_id").limit(MAX_EVENTS_PER_RUN + 1).lean(),
  ]);
  if (events.length + specialEvents.length > MAX_EVENTS_PER_RUN) {
    throw new Error("Too many recent guest lists to reconcile in one run");
  }
  for (const event of events) await enqueue("event", { id: String(event._id) });
  for (const event of specialEvents) await enqueue("special-event", { id: String(event._id) });
  return { events: events.length, specialEvents: specialEvents.length };
}

export async function scheduleGuestListReconciliation(getQueue = getSpreadsheetSyncQueue) {
  return getQueue().upsertJobScheduler(GUEST_LIST_RECONCILIATION_JOB,
    { every: GUEST_LIST_RECONCILIATION_INTERVAL_MS },
    { name: GUEST_LIST_RECONCILIATION_JOB, data: {}, opts: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 100 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 100 },
    } });
}
