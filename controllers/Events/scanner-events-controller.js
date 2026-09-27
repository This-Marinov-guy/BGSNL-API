import Event from "../../models/Event.js";
import HttpError from "../../models/Http-error.js";
import { ACCESS_4, ALL_EVENT_REGIONS_ACCESS, DEFAULT_REGION, EVENT_DRAFT } from "../../util/config/defines.js";

export const createScannerEventsHandler = ({ EventModel = Event } = {}) => async (req, res, next) => {
  const roles = req.user?.roles || [];
  if (!roles.some(role => ACCESS_4.includes(role))) return next(new HttpError("No access to ticket scanning", 403));
  const allRegions = roles.some(role => ALL_EVENT_REGIONS_ACCESS.includes(role));
  if (!allRegions && (!req.user?.region || req.user.region === DEFAULT_REGION)) {
    return next(new HttpError("No access to a regional event list", 403));
  }
  const filter = {
    status: { $nin: ["archived", EVENT_DRAFT] },
    ...(!allRegions ? { region: req.user.region } : {}),
  };
  try {
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
  } catch {
    return next(new HttpError("Scanner events could not be loaded", 500));
  }
};

export const getScannerEvents = createScannerEventsHandler();
