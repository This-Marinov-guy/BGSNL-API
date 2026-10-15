import { createHash } from "node:crypto";
import mongoose from "mongoose";
import Event from "../../models/Event.js";
import HttpError from "../../models/Http-error.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ticketIssued = ticket => Boolean(ticket?.ticket || ticket?.ticketToken ||
  (ticket?.transactionId && ticket.transactionId !== "-"));

export const feedbackRecipientHash = email => createHash("sha256")
  .update(String(email || "").trim().toLowerCase()).digest("hex");

export const feedbackDueAt = event => new Date(new Date(event.correctedDate || event.date).getTime() + DAY_MS);

export function createEventFeedbackService({ EventModel = Event,
  now = () => new Date() } = {}) {
  const ticketContext = async ticketId => {
    const event = await EventModel.findOne({ "guestList._id": ticketId });
    const ticket = event?.guestList?.find(item => String(item._id) === String(ticketId));
    if (!ticket || !ticketIssued(ticket) || ticket.refunded) throw new HttpError("This feedback link is not available for a valid ticket.", 404);
    if (event.status === "draft" || event.status === "cancelled" || event.cancellationRequestedAt) {
      throw new HttpError("Feedback is not available for this event.", 410);
    }
    const dueAt = feedbackDueAt(event);
    if (!Number.isFinite(dueAt.getTime())) throw new HttpError("The event date is unavailable. Please try again later.", 503);
    return { event, ticket, dueAt, recipientHash: feedbackRecipientHash(ticket.email) };
  };

  const state = async ticketId => {
    const { event, ticket, dueAt, recipientHash } = await ticketContext(ticketId);
    const submitted = (event.feedbacks || []).some(response =>
      String(response.ticketId) === String(ticket._id) || response.recipientHash === recipientHash);
    return { eventTitle: event.title, eventPoster: event.poster || null, opensAt: dueAt.toISOString(),
      state: submitted ? "submitted" : now() < dueAt ? "not_ready" : "ready" };
  };

  const submit = async (ticketId, answers) => {
    const { event, ticket, dueAt, recipientHash } = await ticketContext(ticketId);
    if (now() < dueAt) throw new HttpError("Feedback opens one day after the event.", 409);
    const clean = {
      enjoyment: answers.enjoyment,
      organisation: answers.organisation,
      favoriteMoment: answers.favoriteMoment.trim(),
      improvements: answers.improvements.trim(),
      futureEvents: answers.futureEvents.trim(),
      additionalComments: (answers.additionalComments || "").trim(),
    };
    const result = await EventModel.updateOne({ _id: event._id, cancellationRequestedAt: null,
      status: { $nin: ["draft", "cancelled"] },
      guestList: { $elemMatch: { _id: ticket._id, refunded: { $ne: true } } },
      feedbacks: { $not: { $elemMatch: { $or: [{ ticketId: ticket._id }, { recipientHash }] } } },
    }, { $push: { feedbacks: { _id: new mongoose.Types.ObjectId(), ticketId: ticket._id,
      recipientHash, answers: clean, submittedAt: now() } } });
    if (!result.modifiedCount) {
      const current = await EventModel.findById(event._id).select("feedbacks").lean();
      const duplicate = (current?.feedbacks || []).some(response =>
        String(response.ticketId) === String(ticket._id) || response.recipientHash === recipientHash);
      throw new HttpError(duplicate ? "Feedback has already been submitted for this ticket or email address."
        : "Feedback is no longer available for this event.", 409);
    }
    return { status: true, eventTitle: event.title };
  };

  return { state, submit };
}

export const eventFeedback = createEventFeedbackService();
