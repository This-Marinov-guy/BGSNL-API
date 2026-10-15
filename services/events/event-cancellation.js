import { createHash } from "node:crypto";
import Event from "../../models/Event.js";
import { DOMAKIN_NOTIFICATION_TEMPLATE } from "../background-services/email-provider.js";
import { queueDomakinTemplateEmail } from "../background-services/domakin-mailer.js";
import { refundEventTickets } from "../main-services/event-action-service.js";
import { archiveEvent } from "./archive-event.js";
import { withBillingLease } from "../subscriptions/lease.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { runObservedJob } from "../monitoring/job-history.js";
import { isEmailSchedulerProcess } from "../background-services/email-run-guard.js";
import { loadRegionEmails } from "../region-contacts.js";
import { eventEmailPreviewMobileCss, formatEventEmailDate, renderEventEmailPreview } from "./event-email-preview.js";

const RETRY_MS = 5 * 60 * 1000;
const escapeHtml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const validEmail = value => typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const hasPayment = ticket => Boolean(ticket.transactionId && ticket.transactionId !== "-");
const isMemberTicket = ticket => ["member", "free member"].includes(ticket.type) ||
  ticket.memberPriceApplied === true || ticket.memberPriceApplied === "true";

export function eventCancellationMessage(event, contactEmail, tickets = null) {
  if (!validEmail(contactEmail)) throw new Error("Event region contact email is missing");
  const date = formatEventEmailDate(event);
  const contactSubject = `Question about cancelled event: ${event.title}`;
  const address = contactEmail.trim().toLowerCase();
  const contactHref = `mailto:${encodeURIComponent(address).replace("%40", "@")}?subject=${encodeURIComponent(contactSubject)}`;
  const refundDue = tickets ? tickets.some(hasPayment) : event.isFree !== true;
  const refundDetails = refundDue
    ? "A refund will be issued by the event organizer automatically. If you have any questions please contact us."
    : "Your free ticket has been cancelled. No payment was taken, so no refund is due. If you have any questions please contact us.";
  return {
    subject: `Event cancelled: ${event.title}`,
    html: `<style>${eventEmailPreviewMobileCss}</style><p style="margin:0 0 20px;color:#173f35;font-size:16px;line-height:1.6;font-weight:400;">We are sorry to announce that this event is <strong style="color:#b42318;font-weight:700;">cancelled</strong></p>${renderEventEmailPreview({ title: event.title, date, poster: event.poster, region: event.region })}<p style="margin:0 0 20px;">${refundDetails}</p><p align="center" style="margin:0;text-align:center;"><a href="${escapeHtml(contactHref)}" style="display:inline-block;box-sizing:border-box;min-height:44px;background:#173f35;color:#ffffff;border-radius:8px;padding:13px 20px;text-decoration:none;font-weight:700;text-align:center;">Contact us</a></p>`,
    text: `We are sorry to announce that this event is cancelled.\n\n${event.title}${date ? `\n${date}` : ""}\n\n${refundDetails}\n\nContact us: ${address} (subject: ${contactSubject})`,
  };
}

export function cancellationCounts(event) {
  const pending = (event.guestList || []).filter(ticket => ticket.refunded !== true);
  const paid = pending.filter(hasPayment);
  const guests = pending.filter(ticket => !isMemberTicket(ticket));
  const members = pending.filter(isMemberTicket);
  const paidGuests = guests.filter(hasPayment).length;
  const paidMembers = members.filter(hasPayment).length;
  return {
    guest: paidGuests,
    member: paidMembers,
    paid: paid.length,
    free: pending.length - paid.length,
    total: pending.length,
    guestTotal: guests.length,
    memberTotal: members.length,
    guestFree: guests.length - paidGuests,
    memberFree: members.length - paidMembers,
  };
}

function deliveryIdentity(eventId, email) {
  const digest = createHash("sha256").update(`${eventId}:${email}`).digest("hex");
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return { operationId: uuid };
}

export function cancellationRecipients(event) {
  const recipients = new Map();
  for (const ticket of event.guestList || []) {
    if (!validEmail(ticket.email)) continue;
    const email = ticket.email.trim().toLowerCase();
    if (!recipients.has(email)) recipients.set(email, []);
    recipients.get(email).push(ticket);
  }
  return recipients;
}

export function createEventCancellationService({ EventModel = Event,
  refund = refundEventTickets, archive = archiveEvent, send = queueDomakinTemplateEmail,
  lease = withBillingLease, loadContacts = loadRegionEmails, now = () => new Date() } = {}) {
  async function process(eventId) {
    return lease(`event-cancellation:${eventId}`, async ({ assertOwned }) => {
      let event = await EventModel.findById(eventId);
      if (!event?.cancellationRequestedAt) return { skipped: true };
      if (event.cancellationCompletedAt && !event.guestList?.some(ticket => ticket.refunded !== true)) return { skipped: true };
      if (event.archiveCleanupPending) {
        try { await archive(eventId); }
        catch (error) { logOperationalError("worker.event-cancellation-archive", error); }
      }
      const refundResult = await lease(`event-refund:${eventId}`, async ({ assertOwned: assertRefundOwned }) => {
        await assertRefundOwned();
        return refund(eventId, "event cancellation", event.region, null, {
          mode: "full", idempotencyPrefix: `event-cancellation:${eventId}`,
          refundRemainingPayments: true,
        });
      });
      event = await EventModel.findById(eventId);
      let failed = refundResult.summary.failed + Number(Boolean(event.archiveCleanupPending));
      const invalidRecipients = event.guestList.filter(ticket => !validEmail(ticket.email)).length;
      if (invalidRecipients) {
        failed += invalidRecipients;
        logOperationalError("worker.event-cancellation-invalid-recipient",
          new Error(`${invalidRecipients} ticket recipient email address(es) require correction`));
      }
      const recipients = cancellationRecipients(event);
      let contactEmail = "";
      let contactError;
      if (recipients.size) {
        try { contactEmail = (await loadContacts())[event.region] || ""; }
        catch (error) { contactError = error; }
      }
      if (recipients.size && !validEmail(contactEmail)) {
        failed++;
        logOperationalError("worker.event-cancellation-contact", contactError || new Error(`Missing contact email for ${event.region}`));
      }
      for (const [email, tickets] of validEmail(contactEmail) ? recipients : []) {
        if (tickets.some(ticket => ticket.refunded !== true)) continue;
        const { operationId } = deliveryIdentity(eventId, email);
        try {
          await assertOwned();
          await send(DOMAKIN_NOTIFICATION_TEMPLATE, email,
            eventCancellationMessage(event, contactEmail, tickets), { operationId });
        } catch (error) {
          failed++;
          logOperationalError("worker.event-cancellation-email", error);
        }
      }
      if (event.guestList.some(ticket => ticket.refunded !== true)) failed++;
      await assertOwned();
      await EventModel.updateOne({ _id: eventId }, failed
        ? { $set: { cancellationRetryAt: new Date(now().getTime() + RETRY_MS) }, $unset: { cancellationCompletedAt: 1 } }
        : { $set: { cancellationCompletedAt: now() }, $unset: { cancellationRetryAt: 1 } });
      return { failed, completed: !failed };
    });
  }

  async function tick() {
    const ready = await EventModel.find({ cancellationRequestedAt: { $ne: null },
      $or: [{ cancellationCompletedAt: null }, { guestList: { $elemMatch: { refunded: { $ne: true } } } }],
      cancellationRetryAt: { $not: { $gt: now() } },
    }).select("_id").limit(20).lean();
    let failed = 0;
    for (const event of ready) {
      try { failed += (await process(String(event._id))).failed || 0; }
      catch (error) { failed++; logOperationalError("worker.event-cancellation", error); }
    }
    return { failed, processed: ready.length, skipped: !ready.length };
  }
  return { process, tick };
}

export function startEventCancellationWorker({ enabled = isEmailSchedulerProcess(), service = createEventCancellationService(),
  intervalMs = 60_000 } = {}) {
  if (!enabled) return async () => {};
  let running;
  const tick = () => {
    if (running) return;
    running = runObservedJob("scheduler", "event-cancellation", () => service.tick())
      .catch(error => logOperationalError("worker.event-cancellation", error)).finally(() => { running = null; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return async () => { clearInterval(timer); await running; };
}
