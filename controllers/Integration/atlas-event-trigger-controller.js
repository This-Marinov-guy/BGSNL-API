import Event from "../../models/Event.js";
import HttpError from "../../models/Http-error.js";
import { announcementWorkerEnabled, pendingMemberEventAnnouncements, wakeMemberEventAnnouncementWorker } from "../../services/events/member-event-announcements.js";

export const createAtlasEventTriggerHandler = ({ EventModel = Event, enabled = announcementWorkerEnabled, wake = wakeMemberEventAnnouncementWorker } = {}) => async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  try {
    if (!enabled()) throw new HttpError("Event announcements are disabled.", 503);
    const eventId = req.body?.eventId;
    if (typeof eventId !== "string" || !/^[a-f\d]{24}$/i.test(eventId)) throw new HttpError("A valid eventId is required.", 400);
    // Read committed state; webhook bodies cannot create a publication marker,
    // choose recipients/prices, or reopen a completed announcement.
    const pending = await EventModel.exists({ _id: eventId, ...pendingMemberEventAnnouncements() });
    if (!pending) return res.status(200).json({ status: "ignored" });
    if (!wake()) throw new HttpError("Event announcement worker is unavailable.", 503);
    return res.status(202).json({ status: "queued" });
  } catch (error) { return next(error); }
};
