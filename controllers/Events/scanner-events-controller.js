import Event from "../../models/Event.js";
import HttpError from "../../models/Http-error.js";
import { EVENT_MANAGEMENT_ACCESS, EVENT_DRAFT } from "../../util/config/defines.js";
import { regionFilter } from "../../middleware/authorization.js";

export const createScannerEventsHandler = ({ EventModel = Event } = {}) => async (req, res, next) => {
  const roles = req.user?.roles || [];
  if (!roles.some(role => EVENT_MANAGEMENT_ACCESS.includes(role))) return next(new HttpError("No access to ticket scanning", 403));
  try {
    const filter = {
      status: { $nin: ["archived", EVENT_DRAFT] },
      ...regionFilter(req, "event"),
    };
    // Project at the database: never load guest lists, payment data, or drafts.
    const events = await EventModel.find(filter)
      .select("_id title region date correctedDate poster status")
      .sort({ correctedDate: -1, date: -1, _id: -1 })
      .lean();
    res.set("Cache-Control", "private, no-store");
    return res.status(200).json({ events: events.map(event => ({
      id: String(event._id), title: event.title, region: event.region,
      date: event.date, correctedDate: event.correctedDate,
      poster: event.poster, status: event.status,
    })) });
  } catch (error) {
    return next(error instanceof HttpError ? error : new HttpError("Scanner events could not be loaded", 500));
  }
};

export const getScannerEvents = createScannerEventsHandler();
