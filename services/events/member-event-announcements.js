import Event from "../../models/Event.js";
import User from "../../models/User.js";
import { createEmailRunGuard, isEmailSchedulerProcess } from "../background-services/email-run-guard.js";
const announcementRuns = createEmailRunGuard();
import { queueDomakinTemplateEmail } from "../background-services/domakin-mailer.js";
import { NO_REPLY_EMAIL, NO_REPLY_EMAIL_NAME, MEMBER_EVENT_ANNOUNCEMENT_TEMPLATE } from "../../util/config/defines.js";
import { createMemberEventLink, eventPageUrl, isCurrentEventMember, isPublicUpcomingEvent, memberEventPrice } from "./member-event-links.js";

const plainText = (value) => String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
// The branded header/footer shell lives in Domakin Mailer's own
// "member-event-announcement" template; this only sends the message envelope.
const deliverTemplateMessage = (message) => queueDomakinTemplateEmail(message.templateId, message.to[0].email, message.templateVariables);
export const announcementWorkerEnabled = (env = process.env) => isEmailSchedulerProcess(env) && (env.EVENT_ANNOUNCEMENTS_ENABLED === undefined ? env.NODE_ENV === "production" : env.EVENT_ANNOUNCEMENTS_ENABLED === "true");
export const pendingMemberEventAnnouncements = (now = new Date()) => ({ memberAnnouncementQueuedAt: { $exists: true, $lte: now }, memberAnnouncementCompletedAt: { $exists: false }, hidden: { $ne: true }, status: { $nin: ["draft", "archived"] } });

let wakeWorker;
// The committed publication marker is the durable queue; this only reduces
// latency. A process crash after HTTP acknowledgement is recovered by polling.
export const wakeMemberEventAnnouncementWorker = () => wakeWorker?.() ?? false;

export function buildMemberEventEmail({ event, member, ticketUrl }) {
  const price = memberEventPrice(event, member);
  const amount = Number(price?.price);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Member ticket price is not configured");
  const priceLabel = amount === 0 ? "Free" : new Intl.NumberFormat("en-NL", { style: "currency", currency: "EUR" }).format(amount);
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", dateStyle: "full", timeStyle: "short" }).format(new Date(event.correctedDate || event.date));
  const title = plainText(event.title);
  const description = plainText(event.description || event.text).slice(0, 1600);
  const viewUrl = eventPageUrl(event);
  return {
    templateId: MEMBER_EVENT_ANNOUNCEMENT_TEMPLATE,
    templateVariables: {
      name: member.name || "there",
      title,
      date,
      location: event.location,
      description,
      priceLabel,
      viewUrl,
      ticketUrl,
    },
  };
}

export async function processMemberEventAnnouncements({ now = new Date(), enabled = announcementWorkerEnabled(), EventModel = Event, MemberModel = User, runGuard = announcementRuns, send = deliverTemplateMessage, makeLink = createMemberEventLink } = {}) {
  if (!enabled) return { sent: 0, failed: 0, skipped: 0 };
  // No createdAt backfill: only explicit publication markers from this feature
  // can trigger a mailing. Ordinary edits cannot queue another announcement.
  const events = await EventModel.find(pendingMemberEventAnnouncements(now)).limit(10);
  const totals = { sent: 0, failed: 0, skipped: 0 };
  for (const event of events) {
    if (!isPublicUpcomingEvent(event, now.getTime()) || new Date(event.ticketTimer) <= now) {
      await EventModel.updateOne({ _id: event._id }, { $set: { memberAnnouncementCompletedAt: now } });
      continue;
    }
    const members = await MemberModel.find({ status: "active", expireDate: { $gt: now } }).select("_id name surname email roles status expireDate").lean();
    const seen = new Set();
    for (const member of members) {
      const email = String(member.email || "").trim().toLowerCase();
      if (!isCurrentEventMember(member, now.getTime()) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || seen.has(email)) continue;
      seen.add(email);
      // Build first: configuration failures leave the event pending for retry.
      const notification = buildMemberEventEmail({ event, member, ticketUrl: makeLink(event, member) });
      if (!runGuard.claim(String(event._id), email)) { totals.skipped += 1; continue; }
      try {
        let timer;
        try {
          await Promise.race([
            send({ from: { email: NO_REPLY_EMAIL, name: NO_REPLY_EMAIL_NAME }, to: [{ email }], ...notification, category: "new-member-event" }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Delivery not confirmed")), 100000); }),
          ]);
        } finally { clearTimeout(timer); }
        totals.sent += 1;
      } catch {
        totals.failed += 1;
      }
    }
    await EventModel.updateOne({ _id: event._id }, { $set: { memberAnnouncementCompletedAt: new Date() } });
  }
  return totals;
}

export function startMemberEventAnnouncementWorker({ enabled = announcementWorkerEnabled(), process = processMemberEventAnnouncements, intervalMs = 60000 } = {}) {
  if (!enabled) return async () => {};
  let running;
  let requested = false;
  let stopped = false;
  const tick = () => {
    if (stopped) return false;
    requested = true;
    if (running) return true;
    requested = false;
    running = Promise.resolve().then(() => process({ enabled })).then((result) => {
      if (result.failed) console.error("Event announcement emails failed", { failed: result.failed });
    }).catch((error) => console.error("Event announcement worker failed", { code: error?.code, message: error?.message }))
      .finally(() => {
        running = null;
        if (requested && !stopped) tick();
      });
    return true;
  };
  wakeWorker = tick;
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    if (wakeWorker === tick) wakeWorker = undefined;
    clearInterval(timer);
    await running;
  };
}
