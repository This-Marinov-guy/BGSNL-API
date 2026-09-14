import mongoose from "mongoose";
import Event from "../../models/Event.js";
import HttpError from "../../models/Http-error.js";
import { ACCESS_2, ACCESS_4, EVENT_OPENED } from "../../util/config/defines.js";
import { stampEventMetadata } from "../../services/events/event-metadata.js";
import { dispatchSitemapRefresh } from "../../services/public-content/sitemap-dispatch.js";

export const createEventSalesHandler = ({ EventModel = Event, refresh = dispatchSitemapRefresh } = {}) => async (req, res, next) => {
  try {
    const roles = req.user?.roles || [];
    if (!roles.some((role) => ACCESS_4.includes(role))) throw new HttpError("No access to manage event sales", 403);
    if (!mongoose.isValidObjectId(req.params.eventId)) throw new HttpError("Invalid event ID", 400);
    if (typeof req.body?.isSaleClosed !== "boolean") throw new HttpError("Sales status must be true or false", 400);
    const event = await EventModel.findById(req.params.eventId);
    if (!event) throw new HttpError("No such event", 404);
    if (!roles.some((role) => ACCESS_2.includes(role)) && (!req.user?.region || event.region !== req.user.region || event.region === "netherlands")) {
      throw new HttpError("You can only manage sales for your region", 403);
    }
    if (["draft", "archived", "cancelled"].includes(event.status)) throw new HttpError("Sales cannot be changed for this event", 409);
    const now = new Date();
    if (!req.body.isSaleClosed) {
      if (!event.date || new Date(event.date) <= now) throw new HttpError("Sales cannot be reopened for a past event", 409);
      // An expired deadline would otherwise immediately close sales again.
      if (!event.ticketTimer || new Date(event.ticketTimer) <= now) event.ticketTimer = event.date;
      if (event.status === "closed") event.status = EVENT_OPENED;
    }
    event.isSaleClosed = req.body.isSaleClosed;
    stampEventMetadata(event, req, { now });
    await event.save({ validateModifiedOnly: true });
    void refresh("sales-updated", event);
    return res.status(200).json({ status: true, event: event.toObject({ getters: true }) });
  } catch (error) {
    return next(error instanceof HttpError ? error : new HttpError("Updating event sales failed", 500));
  }
};

export const updateEventSales = createEventSalesHandler();
