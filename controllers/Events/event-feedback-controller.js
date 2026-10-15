import HttpError from "../../models/Http-error.js";
import mongoose from "mongoose";
import Event from "../../models/Event.js";
import { canAccessRegion } from "../../middleware/authorization.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { eventFeedback } from "../../services/events/event-feedback.js";

const REPORT_PAGE_SIZE = 20;

export const createFeedbackReportHandler = ({ EventModel = Event } = {}) => async (req, res, next) => {
  try {
    const { eventId } = req.params;
    if (!mongoose.isValidObjectId(eventId)) throw new HttpError("Invalid event ID", 422);
    const pageText = String(req.query.page ?? "1");
    if (!/^[1-9]\d*$/.test(pageText) || Number(pageText) > 100000) throw new HttpError("Invalid feedback page", 422);
    const page = Number(pageText);
    const event = await EventModel.findById(eventId).select("title region").lean();
    if (!event) throw new HttpError("Event not found", 404);
    if (!canAccessRegion(req, "event", event.region)) throw new HttpError("No access to this event's feedback", 403);
    const detail = await EventModel.findById(eventId).select("guestList._id guestList.name guestList.email feedbacks").lean();
    if (!detail) throw new HttpError("Event not found", 404);

    const sorted = [...(detail.feedbacks || [])].sort((left, right) =>
      new Date(right.submittedAt) - new Date(left.submittedAt) || String(right._id).localeCompare(String(left._id)));
    const total = sorted.length;
    const records = sorted.slice((page - 1) * REPORT_PAGE_SIZE, page * REPORT_PAGE_SIZE);
    const guests = new Map((detail.guestList || []).map(guest => [String(guest._id), guest]));
    res.set("Cache-Control", "private, no-store");
    return res.status(200).json({ status: true, eventId: String(event._id), title: event.title,
      page, pageSize: REPORT_PAGE_SIZE, total, pages: Math.max(1, Math.ceil(total / REPORT_PAGE_SIZE)),
      responses: records.map(record => {
        const guest = guests.get(String(record.ticketId));
        return { id: String(record._id), ticketId: String(record.ticketId), name: guest?.name || "Ticket holder unavailable",
          email: guest?.email || null, submittedAt: record.submittedAt, answers: record.answers };
      }) });
  } catch (error) {
    if (error instanceof HttpError) return next(error);
    logOperationalError("service.event-feedback-report", error);
    return next(new HttpError("We could not load this event's feedback. Please try again.", 503));
  }
};

export const feedbackReport = createFeedbackReportHandler();

export const feedbackState = async (req, res, next) => {
  try {
    res.set("Cache-Control", "private, no-store");
    return res.status(200).json({ status: true, ...await eventFeedback.state(req.params.ticketId) });
  } catch (error) {
    if (error instanceof HttpError) return next(error);
    logOperationalError("service.event-feedback-state", error);
    return next(new HttpError("We could not load this feedback form. Please try again.", 503));
  }
};

export const submitFeedback = async (req, res, next) => {
  try {
    res.set("Cache-Control", "private, no-store");
    return res.status(201).json(await eventFeedback.submit(req.params.ticketId, req.body.answers));
  } catch (error) {
    if (error instanceof HttpError) return next(error);
    logOperationalError("service.event-feedback-submit", error);
    return next(new HttpError("We could not save your feedback. Your answers are still on this page; please try again.", 503));
  }
};
