import { createHash } from "node:crypto";
import moment from "moment-timezone";
import Event from "../../models/Event.js";
import { normalizeMarketingEmail } from "../../models/MarketingEmail.js";
import { REGIONS } from "../../util/config/defines.js";
import { academicYearRange, academicYearSchedule, ACADEMIC_YEAR_TIME_ZONE } from "../../util/config/academic-year.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { queueDomakinTemplateEmail } from "../background-services/domakin-mailer.js";
import { isEmailSchedulerProcess } from "../background-services/email-run-guard.js";
import { redisClient, redisPrefix } from "../storage/redis.js";
import { createGuestSignupLink } from "./guest-signup-prefill.js";
import { findGuestMarketingAudience, isGuestMarketingRecipient } from "./guest-marketing-emails.js";
import { standardTicketSavingsCents } from "./guest-savings-campaign.js";
import { availableEventPoster, buildGuestSavingsTemplateVariables, GUEST_SAVINGS_TEMPLATE } from "./guest-savings-email.js";
import { formatEventEmailDate } from "./event-email-preview.js";

const MAX_GUESTS = 20_000;
const MAX_EVENTS = 2_000;
const DAY_MS = 86400_000;
const FIRST_EVENT_CATCHUP_MS = 14 * DAY_MS;
const invalidEventStatuses = new Set(["draft", "cancelled", "canceled"]);
const eventDate = event => new Date(event.correctedDate || event.date);
const uuidFor = (...parts) => {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};
const splitName = value => {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  return { name: parts[0] || "", surname: parts.slice(1).join(" ") };
};
const guestTicket = ticket => !ticket.refunded && ticket.memberPriceApplied !== true &&
  (ticket.type === "guest" || ticket.type === "free guest" || (!ticket.type && !ticket.userId)) &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeMarketingEmail(ticket.email));
const paidGuestTicket = ticket => guestTicket(ticket) && ticket.type === "guest";

export const guestCampaignsEnabled = (env = process.env) => env.GUEST_CAMPAIGNS_ENABLED === "true" ||
  (env.GUEST_CAMPAIGNS_ENABLED === undefined && env.NODE_ENV === "production");

export function firstPaidGuestEvents(events, { start, now }) {
  const first = new Map();
  for (const event of events) {
    const date = eventDate(event);
    if (!REGIONS.includes(event.region) || !Number.isFinite(+date) || date < start || +date + DAY_MS > +now ||
      event.hidden || event.cancellationRequestedAt || invalidEventStatuses.has(event.status) ||
      event.isFree || event.ticketLink || !(Number(event.product?.guest?.price) > 0) ||
      !(event.guestList || []).some(paidGuestTicket)) continue;
    const prior = first.get(event.region);
    if (!prior || date < eventDate(prior) || (+date === +eventDate(prior) && String(event._id) < String(prior._id))) {
      first.set(event.region, event);
    }
  }
  return first;
}

export async function sendFirstPaidGuestEvent(event, academicYear, {
  audience = findGuestMarketingAudience, eligible = isGuestMarketingRecipient,
  send = queueDomakinTemplateEmail, makeLink = createGuestSignupLink,
} = {}) {
  const allowed = new Set((await audience({ academicYear, region: event.region })).map(row => normalizeMarketingEmail(row.email)));
  const recipients = new Map();
  for (const ticket of event.guestList || []) {
    const email = normalizeMarketingEmail(ticket.email);
    if (!paidGuestTicket(ticket) || !allowed.has(email)) continue;
    const entry = recipients.get(email) || { ticket, count: 0 };
    entry.count++;
    recipients.set(email, entry);
  }
  if (recipients.size > MAX_GUESTS) throw new Error("First paid event audience is too large");
  const batchId = uuidFor("guest-first-paid-event", academicYear, event.region);
  let sent = 0, skipped = 0, failed = 0;
  for (const [email, { ticket, count }] of recipients) {
    try {
      if (!await eligible(email)) { skipped++; continue; }
      const { name, surname } = splitName(ticket.name);
      const totalCents = standardTicketSavingsCents(event) * count;
      const variables = buildGuestSavingsTemplateVariables({ name, totalCents, showPosters: false,
        eventSavings: totalCents ? [{ title: event.title, tickets: count, savingsCents: totalCents,
          date: formatEventEmailDate(event) }] : [],
        region: event.region, signupUrl: makeLink({ email, region: event.region, name, surname, phone: ticket.phone || "" }) });
      variables.subject = totalCents
        ? `Your ${event.title} ticket${count === 1 ? "" : "s"} could have cost ${variables.total} less as a member`
        : `Membership benefits after ${event.title}`;
      await send(GUEST_SAVINGS_TEMPLATE, email, variables, {
        operationId: uuidFor("guest-first-paid-event", academicYear, event.region, email),
        bulk: { batchId, batchType: "guest_first_paid_event", totalRecipients: recipients.size,
          source: "bgsnl-guest-campaigns", sourceId: String(event._id), audience: "guests" },
      });
      sent++;
    } catch (error) {
      failed++;
      logOperationalError("guest-campaign.first-paid-event-recipient", error, { academicYear, region: event.region });
    }
  }
  if (failed) throw new Error(`${failed} first paid guest event emails failed`);
  return { sent, skipped };
}

export async function runDueFirstPaidGuestEventCampaigns({ now = new Date(), EventModel = Event,
  clientFor = redisClient, sendEvent = sendFirstPaidGuestEvent } = {}) {
  const { start } = academicYearRange(now);
  const cutoff = new Date(+now - DAY_MS);
  if (cutoff < start) return { status: "not-due" };
  const events = await EventModel.find({ $or: [
    { date: { $gte: start, $lte: cutoff } },
    { correctedDate: { $gte: start, $lte: cutoff } },
  ] }).select("_id title date correctedDate status hidden cancellationRequestedAt region product isFree isMemberFree ticketLink guestList.email guestList.name guestList.phone guestList.type guestList.userId guestList.memberPriceApplied guestList.refunded")
    .limit(MAX_EVENTS + 1).lean();
  if (events.length > MAX_EVENTS) throw new Error("Too many events for first paid guest event campaign");
  const first = firstPaidGuestEvents(events, { start, now });
  if (!first.size) return { status: "not-due" };
  const academicYear = academicYearSchedule(now).academicYear;
  const client = await clientFor();
  let sent = 0, skipped = 0, failed = 0;
  for (const [region, event] of first) {
    // A delayed deployment must not send a months-old first-event promotion.
    if (+now > +eventDate(event) + DAY_MS + FIRST_EVENT_CATCHUP_MS) continue;
    const key = `${redisPrefix()}guest-first-paid-event:${academicYear}:${region}`;
    if (await client.get(key)) continue;
    try {
      const result = await sendEvent(event, academicYear);
      sent += result.sent;
      skipped += result.skipped;
      await client.set(key, String(event._id), { EX: 400 * 86400 });
    } catch (error) {
      failed++;
      logOperationalError("guest-campaign.first-paid-event", error, { academicYear, region });
    }
  }
  if (failed) throw new Error(`${failed} first paid guest event regions failed`);
  return { status: "processed", sent, skipped };
}

export function startFirstPaidGuestEventCampaignWorker({ enabled = guestCampaignsEnabled() && isEmailSchedulerProcess(),
  intervalMs = 3600_000, process = runDueFirstPaidGuestEventCampaigns } = {}) {
  if (!enabled) return async () => {};
  let running;
  const tick = () => {
    if (running) return;
    running = process().catch(error => logOperationalError("guest-campaign.first-paid-event-worker", error))
      .finally(() => { running = null; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => { clearInterval(timer); await running; };
}

export function dueGuestTermCampaigns(now = new Date()) {
  const schedule = academicYearSchedule(now);
  return ["term2", "term3"].flatMap(term => {
    const dueAt = moment(schedule[term]).tz(ACADEMIC_YEAR_TIME_ZONE).endOf("day").toDate();
    // An outage can be recovered without mailing a stale recap months later.
    return now >= dueAt && now < new Date(+dueAt + 14 * 86400_000)
      ? [{ term, academicYear: schedule.academicYear, dueAt }] : [];
  });
}

export function guestSavingsByEmail(events, { start, cutoff }) {
  const savings = new Map();
  for (const event of events) {
    const date = eventDate(event);
    if (!Number.isFinite(+date) || date < start || date > cutoff || event.hidden || invalidEventStatuses.has(event.status)) continue;
    const each = standardTicketSavingsCents(event);
    if (!each) continue;
    const counts = new Map();
    for (const ticket of event.guestList || []) {
      if (!guestTicket(ticket)) continue;
      const email = normalizeMarketingEmail(ticket.email);
      counts.set(email, (counts.get(email) || 0) + 1);
    }
    for (const [email, tickets] of counts) {
      if (!savings.has(email)) savings.set(email, []);
      savings.get(email).push({ title: String(event.title || "Event"), tickets, savingsCents: each * tickets,
        date: formatEventEmailDate(event), poster: availableEventPoster(event) });
    }
  }
  for (const rows of savings.values()) rows.sort((a, b) => a.title.localeCompare(b.title));
  return savings;
}

export function regionalEventsSoFar(events, region, { start, cutoff }) {
  return events.flatMap(event => {
    const date = eventDate(event);
    return event.region === region && !event.hidden && !invalidEventStatuses.has(event.status) &&
      Number.isFinite(+date) && date >= start && date <= cutoff
      ? [{ title: String(event.title || "Event"), date: formatEventEmailDate({ date }), poster: availableEventPoster(event), timestamp: +date }] : [];
  }).sort((a, b) => a.timestamp - b.timestamp || a.title.localeCompare(b.title))
    .map(({ title, date, poster }) => ({ title, date, poster }));
}

export async function sendGuestTermRecap({ term, academicYear, dueAt }, {
  EventModel = Event, audience = findGuestMarketingAudience,
  eligible = isGuestMarketingRecipient, send = queueDomakinTemplateEmail, makeLink = createGuestSignupLink,
} = {}) {
  if (!["term2", "term3"].includes(term) || academicYearSchedule(dueAt).academicYear !== academicYear) {
    throw new Error("Invalid guest term campaign");
  }
  const recipientsByRegion = await Promise.all(REGIONS.map(region => audience({ academicYear, region })));
  const recipients = new Map();
  for (const rows of recipientsByRegion) for (const row of rows) {
    if (row.firstTicketAt && new Date(row.firstTicketAt) > dueAt) continue;
    if (!recipients.has(row.email)) recipients.set(row.email, row.region);
  }
  if (recipients.size > MAX_GUESTS) throw new Error("Guest term campaign audience is too large");
  if (!recipients.size) return { sent: 0, skipped: 0 };
  const { start } = academicYearRange(dueAt);
  const events = await EventModel.find({ $or: [
    { date: { $gte: start, $lte: dueAt } },
    { correctedDate: { $gte: start, $lte: dueAt } },
  ] }).select("_id title date correctedDate status hidden region product isFree isMemberFree ticketLink guestList.email guestList.name guestList.phone guestList.type guestList.userId guestList.memberPriceApplied guestList.refunded poster folder archiveCleanupCompletedAt mediaRetainedAt mediaCleanupAt")
    .limit(MAX_EVENTS + 1).lean();
  if (events.length > MAX_EVENTS) throw new Error("Too many events for guest term campaign");
  const eventSavings = guestSavingsByEmail(events, { start, cutoff: dueAt });
  const termEvents = new Map(REGIONS.map(region => [region, regionalEventsSoFar(events, region, { start, cutoff: dueAt })]));
  const ticketDetails = new Map();
  for (const event of events) for (const ticket of event.guestList || []) {
    if (guestTicket(ticket)) ticketDetails.set(normalizeMarketingEmail(ticket.email), ticket);
  }
  const batchId = uuidFor("guest-term-recap", academicYear, term);
  let sent = 0, skipped = 0, failed = 0;
  for (const [email, region] of recipients) {
    try {
      if (!await eligible(email)) { skipped++; continue; }
      const ticket = ticketDetails.get(email) || {};
      const { name, surname } = splitName(ticket.name);
      const rows = eventSavings.get(email) || [];
      const totalCents = rows.reduce((sum, row) => sum + row.savingsCents, 0);
      const variables = buildGuestSavingsTemplateVariables({ name, eventSavings: rows, totalCents,
        termEvents: termEvents.get(region), region,
        signupUrl: makeLink({ email, region, name, surname, phone: ticket.phone || "" }) });
      variables.subject = totalCents
        ? `${term === "term2" ? "Term 2" : "Term 3"} recap: you could have saved ${variables.total} on event tickets`
        : `${term === "term2" ? "Term 2" : "Term 3"} recap: your BGSNL events and membership benefits`;
      await send(GUEST_SAVINGS_TEMPLATE, email, variables, {
        operationId: uuidFor("guest-term-recap", academicYear, term, email),
        bulk: { batchId, batchType: `guest_${term}_recap`, totalRecipients: recipients.size,
          source: "bgsnl-guest-campaigns", sourceId: academicYear, audience: "guests" },
      });
      sent++;
    } catch (error) {
      failed++;
      logOperationalError("guest-campaign.term-recipient", error, { academicYear, term });
    }
  }
  if (failed) throw new Error(`${failed} guest term recap emails failed`);
  return { sent, skipped };
}

export async function runDueGuestTermCampaigns({ now = new Date(), clientFor = redisClient,
  sendRecap = sendGuestTermRecap } = {}) {
  const due = dueGuestTermCampaigns(now);
  if (!due.length) return { status: "not-due" };
  const client = await clientFor();
  for (const campaign of due) {
    const key = `${redisPrefix()}guest-term-recap:${campaign.academicYear}:${campaign.term}`;
    if (await client.get(key)) continue;
    await sendRecap(campaign);
    await client.set(key, "complete", { EX: 400 * 86400 });
  }
  return { status: "processed" };
}

export function startGuestTermCampaignWorker({ enabled = guestCampaignsEnabled() && isEmailSchedulerProcess(),
  intervalMs = 3600_000, process = runDueGuestTermCampaigns } = {}) {
  if (!enabled) return async () => {};
  let running;
  const tick = () => {
    if (running) return;
    running = process().catch(error => logOperationalError("guest-campaign.term-worker", error))
      .finally(() => { running = null; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => { clearInterval(timer); await running; };
}
