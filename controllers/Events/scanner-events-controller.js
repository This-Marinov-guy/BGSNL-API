import Event from "../../models/Event.js";
import HttpError from "../../models/Http-error.js";
import { EVENT_MANAGEMENT_ACCESS, EVENT_DRAFT } from "../../util/config/defines.js";
import { regionFilter } from "../../middleware/authorization.js";

export const scannerPosterUrl = (value) => {
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com" || url.username || url.password) return value;
    const match = url.pathname.match(/^(\/[^/]+\/image\/upload\/)(v\d+\/.*)$/);
    if (!match) return value;
    url.pathname = `${match[1]}c_limit,w_400/f_auto/q_auto/${match[2]}`;
    return url.toString();
  } catch { return value; }
};

export const createScannerEventsHandler = ({ EventModel = Event } = {}) => async (req, res, next) => {
  const roles = req.user?.roles || [];
  if (!roles.some(role => EVENT_MANAGEMENT_ACCESS.includes(role))) return next(new HttpError("No access to ticket scanning", 403));
  try {
    const filter = {
      status: { $nin: ["archived", EVENT_DRAFT] },
      ...regionFilter(req, "event"),
    };
    const queryEvents = async (query) => {
      const records = await EventModel.find(query)
        .select("_id title region date correctedDate poster status")
        .sort({ correctedDate: -1, date: -1, _id: -1 })
        .lean();
      return records.map(event => ({
        id: String(event._id), title: event.title, region: event.region,
        date: event.date, correctedDate: event.correctedDate,
        poster: scannerPosterUrl(event.poster), status: event.status,
      }));
    };
    const requestedId = typeof req.query?.forEvent === "string" && /^[\da-f]{24}$/i.test(req.query.forEvent)
      ? req.query.forEvent : null;
    const focusedEvents = requestedId ? await queryEvents({ ...filter, _id: requestedId }) : null;
    const events = focusedEvents?.length ? focusedEvents : await queryEvents(filter);
    res.set("Cache-Control", "private, no-store");
    return res.status(200).json({ access: {
      userId: req.user.userId, roles: req.user.roles, status: req.user.status, region: req.user.region,
    }, events });
  } catch (error) {
    return next(error instanceof HttpError ? error : new HttpError("Scanner events could not be loaded", 500));
  }
};

export const getScannerEvents = createScannerEventsHandler();
