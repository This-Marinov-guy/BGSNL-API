import Event from "../../models/Event.js";
import MarketingEmail from "../../models/MarketingEmail.js";
import { queueDomakinTemplateEmail } from "../background-services/domakin-mailer.js";
import { isEmailSchedulerProcess } from "../background-services/email-run-guard.js";
import { runObservedJob } from "../monitoring/job-history.js";
import { startDailyCheck } from "../jobs/calendar-check.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { HOME_URL } from "../../util/config/defines.js";
import { feedbackDueAt, feedbackRecipientHash } from "./event-feedback.js";
import { EVENT_CAMPAIGN_TEMPLATE } from "./event-campaign-email.js";
import { formatEventEmailDate, renderEventEmailPreview, safeEventPosterUrl } from "./event-email-preview.js";

const RETRY_MS = 5 * 60 * 1000;
const UNSCHEDULED_CATCHUP_MS = 2 * 24 * 60 * 60 * 1000;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const escapeHtml = value => String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const feedbackOperationId = value => {
  const digest = feedbackRecipientHash(value);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};
const normalizeEmail = value => String(value || "").trim().toLowerCase();
const consentedAddresses = rows => {
  const allowed = new Set(rows.filter(row => row.consent?.granted === true && !row.unsubscribed)
    .map(row => normalizeEmail(row.email)));
  for (const row of rows) if (row.unsubscribed) allowed.delete(normalizeEmail(row.email));
  return allowed;
};

export function feedbackRecipients(event) {
  const recipients = new Map();
  for (const ticket of event.guestList || []) {
    if (ticket.refunded || !(ticket.ticket || ticket.ticketToken ||
      (ticket.transactionId && ticket.transactionId !== "-"))) continue;
    const email = String(ticket.email || "").trim().toLowerCase();
    if (emailPattern.test(email) && !recipients.has(email)) recipients.set(email, ticket);
  }
  return recipients;
}

export function buildFeedbackEmail(event, ticketId) {
  const title = String(event.title || "your event").trim();
  const link = new URL(`/event-feedback/${ticketId}`, HOME_URL).href;
  const subject = `How was ${title}?`;
  const date = formatEventEmailDate(event);
  return {
    subject,
    html: `<h1 style="color:#173f35;">How was ${escapeHtml(title)}?</h1>${renderEventEmailPreview({ title, date, poster: event.poster, region: event.region })}<p>Thank you for joining us. Your feedback helps us make future events better.</p><p>This short form is linked to your ticket and does not require signing in.</p><p align="center" style="text-align:center;"><a href="${escapeHtml(link)}" style="display:inline-block;box-sizing:border-box;min-height:44px;background:#017363;color:#fff;border-radius:8px;padding:14px 20px;text-decoration:none;font-weight:bold;text-align:center;">Share your feedback</a></p><p>If the button does not work, use this link: <a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
    text: `How was ${title}?${date ? `\n${date}` : ""}${safeEventPosterUrl(event.poster) ? `\nEvent poster: ${safeEventPosterUrl(event.poster)}` : ""}\n\nThank you for joining us. Your feedback helps us make future events better. The form is linked to your ticket and does not require signing in.\n\nShare your feedback: ${link}`,
  };
}

export function createEventFeedbackEmailService({ EventModel = Event, MarketingModel = MarketingEmail,
  send = queueDomakinTemplateEmail, now = () => new Date() } = {}) {
  const canReceiveCampaign = async email => {
    const rows = await MarketingModel.find({ email }).select("email unsubscribed consent").lean();
    return consentedAddresses(rows).has(email);
  };
  const schedule = async () => {
    const time = now();
    const recent = new Date(+time - UNSCHEDULED_CATCHUP_MS);
    const events = await EventModel.find({ cancellationRequestedAt: null, status: { $nin: ["draft", "cancelled"] },
      $or: [
        { correctedDate: { $gt: time } },
        { correctedDate: null, date: { $gt: time } },
        { correctedDate: { $gte: recent, $lte: time } },
        { correctedDate: null, date: { $gte: recent, $lte: time } },
        { feedbackEmailDueAt: { $ne: null }, feedbackEmailCompletedAt: null },
      ],
    }).select("_id date correctedDate feedbackEmailDueAt feedbackEmailCompletedAt").lean();
    let scheduled = 0;
    for (const event of events) {
      if (event.feedbackEmailCompletedAt) continue;
      const dueAt = feedbackDueAt(event);
      if (!Number.isFinite(dueAt.getTime())) continue;
      if (+new Date(event.feedbackEmailDueAt || 0) === +dueAt) continue;
      await EventModel.updateOne({ _id: event._id, feedbackEmailCompletedAt: null },
        { $set: { feedbackEmailDueAt: dueAt } });
      scheduled++;
    }
    return scheduled;
  };

  const process = async eventId => {
    const event = await EventModel.findById(eventId);
    if (!event?.feedbackEmailDueAt || event.feedbackEmailCompletedAt || event.cancellationRequestedAt) return { skipped: true };
    const actualDue = feedbackDueAt(event);
    if (+actualDue !== +new Date(event.feedbackEmailDueAt)) {
      await EventModel.updateOne({ _id: eventId, feedbackEmailCompletedAt: null },
        { $set: { feedbackEmailDueAt: actualDue } });
    }
    if (actualDue > now()) return { skipped: true };
    let accepted = 0, failed = 0;
    const candidates = [...feedbackRecipients(event).keys()];
    const marketing = candidates.length
      ? await MarketingModel.find({ email: { $in: candidates } }).select("email unsubscribed consent").lean()
      : [];
    const allowed = consentedAddresses(marketing);
    const plannedEmails = candidates.filter(email => allowed.has(email));
    const totalRecipients = plannedEmails.length;
    const batchId = feedbackOperationId(`feedback-batch:${eventId}`);
    for (const email of plannedEmails) {
      try {
        const latest = await EventModel.findById(eventId);
        if (!latest || latest.cancellationRequestedAt || ["draft", "cancelled"].includes(latest.status)) break;
        const currentDue = feedbackDueAt(latest);
        if (currentDue > now()) {
          await EventModel.updateOne({ _id: eventId, feedbackEmailCompletedAt: null },
            { $set: { feedbackEmailDueAt: currentDue } });
          return { accepted, failed, skipped: true };
        }
        const ticket = feedbackRecipients(latest).get(email);
        if (!ticket) continue;
        if (!await canReceiveCampaign(email)) continue;
        const operationId = feedbackOperationId(`${eventId}:${email}`);
        await send(EVENT_CAMPAIGN_TEMPLATE, email, buildFeedbackEmail(latest, ticket._id), {
          operationId,
          bulk: { batchId, batchType: "event_feedback", totalRecipients,
            source: "bgsnl-event-feedback", sourceId: String(eventId), audience: "attendees" },
        });
        accepted++;
      } catch (error) {
        failed++;
        logOperationalError("worker.event-feedback-email", error);
      }
    }
    await EventModel.updateOne({ _id: eventId, feedbackEmailCompletedAt: null }, failed
      ? { $set: { feedbackEmailRetryAt: new Date(+now() + RETRY_MS) } }
      : { $set: { feedbackEmailCompletedAt: now() }, $unset: { feedbackEmailRetryAt: 1 } });
    return { accepted, failed };
  };

  const tick = async () => {
    const scheduled = await schedule();
    const due = await EventModel.find({ feedbackEmailDueAt: { $lte: now() },
      feedbackEmailCompletedAt: null, cancellationRequestedAt: null,
      feedbackEmailRetryAt: { $not: { $gt: now() } } }).select("_id").limit(20).lean();
    let accepted = 0, failed = 0;
    for (const event of due) {
      try {
        const result = await process(String(event._id));
        accepted += result.accepted || 0;
        failed += result.failed || 0;
      } catch (error) {
        failed++;
        logOperationalError("worker.event-feedback-email", error);
      }
    }
    return { scheduled, accepted, failed, noWork: !scheduled && !accepted && !failed };
  };
  return { schedule, process, tick };
}

export const eventFeedbackEmailsEnabled = (env = process.env) => env.EVENT_FEEDBACK_EMAIL_ENABLED === "true" ||
  (env.EVENT_FEEDBACK_EMAIL_ENABLED === undefined && env.NODE_ENV === "production");

export function startEventFeedbackEmailWorker({ enabled = eventFeedbackEmailsEnabled() && isEmailSchedulerProcess(),
  service = createEventFeedbackEmailService(), intervalMs } = {}) {
  if (!enabled) return async () => {};
  let running;
  const tick = () => {
    if (running) return;
    running = runObservedJob("scheduler", "event-feedback-email", () => service.tick())
      .catch(error => logOperationalError("worker.event-feedback-email", error))
      .finally(() => { running = null; });
  };
  const stopSchedule = startDailyCheck(tick, { intervalMs });
  return async () => { stopSchedule(); await running; };
}
