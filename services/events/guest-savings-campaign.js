import { createHmac, timingSafeEqual } from "node:crypto";
import Event from "../../models/Event.js";
import MemberUser from "../../models/MemberUser.js";
import AlumniUser from "../../models/AlumniUser.js";
import MarketingEmail from "../../models/MarketingEmail.js";
import Campaign from "../../models/EventEmailCampaign.js";
import HttpError from "../../models/Http-error.js";
import { REGIONS } from "../../util/config/defines.js";
import { academicYearStart } from "../../util/config/academic-year.js";
import { queueDomakinTemplateEmail } from "../background-services/domakin-mailer.js";
import { campaignHash, campaignDeliveryKey, normalizeCampaignEmail } from "./event-campaign-policy.js";
import { createGuestSignupLink } from "./guest-signup-prefill.js";
import { recordEventMailHistory } from "./event-mail-history.js";
import { availableEventPoster, buildGuestSavingsEmail, buildGuestSavingsTemplateVariables, GUEST_SAVINGS_TEMPLATE } from "./guest-savings-email.js";
import { formatEventEmailDate } from "./event-email-preview.js";

const KIND = "guest-savings";
const VERSION = "1";
const MAX_RECIPIENTS = 20000;
const MAX_HISTORY_EVENTS = 2000;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const eventDate = event => new Date(event.correctedDate || event.date);
export { academicYearStart };
export const guestSavingsAvailable = (event, now = new Date()) => event && !event.hidden &&
  !["draft", "cancelled", "canceled"].includes(event.status) &&
  Number.isFinite(eventDate(event).getTime()) && now.getTime() >= eventDate(event).getTime() + 72 * 3600000;
const guestTicket = ticket => !ticket.refunded && ticket.memberPriceApplied !== true &&
  (ticket.type === "guest" || (!ticket.type && !ticket.userId)) &&
  validEmail(normalizeCampaignEmail(ticket.email));
export const standardTicketSavingsCents = event => {
  if (event.isFree || event.ticketLink) return 0;
  if (event.product?.guest?.price == null || (!event.isMemberFree && event.product?.member?.price == null)) return 0;
  const guest = Number(event.product?.guest?.price);
  const member = event.isMemberFree ? 0 : Number(event.product?.member?.price);
  if (!Number.isFinite(guest) || guest < 0 || !Number.isFinite(member) || member < 0) return 0;
  return Math.max(0, Math.round((guest - member) * 100));
};
const splitName = full => {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  return { name: parts[0] || "", surname: parts.slice(1).join(" ") };
};
const recipientHash = ({ totalCents, name, surname, phone, region, eventSavings }) =>
  campaignHash([totalCents, name, surname, phone, region, eventSavings]);
const regionFromCity = city => {
  const value = String(city || "").trim().toLowerCase();
  if (REGIONS.includes(value)) return value;
  if (["breda", "tilburg", "breda-tilburg", "breda tilburg"].includes(value)) return "breda_tilburg";
  if (["leiden", "the hague", "den haag", "leiden-the hague", "leiden the hague"].includes(value)) return "leiden_hague";
  return null;
};

export function createGuestSavingsCampaignService({ EventModel = Event, MemberModel = MemberUser, AlumniModel = AlumniUser, MarketingModel = MarketingEmail,
  CampaignModel = Campaign, now = () => new Date(),
  secret = () => process.env.EVENT_CAMPAIGN_REVIEW_SECRET || process.env.JWT_STRING,
  makeLink = createGuestSignupLink, send = queueDomakinTemplateEmail } = {}) {
  const sign = data => {
    const key = secret();
    if (!key || key.length < 32) throw new HttpError("Campaign review is not configured. Contact an administrator.", 503);
    return createHmac("sha256", key).update(JSON.stringify(data)).digest("hex");
  };
  const loadEvent = async eventId => {
    const event = await EventModel.findById(eventId).lean();
    if (!event) throw new HttpError("This event no longer exists.", 404);
    if (!guestSavingsAvailable(event, now())) throw new HttpError("This email is available 3 days after the event.", 409);
    return event;
  };
  async function inspect(eventId, { includePrior = false } = {}) {
    const event = await loadEvent(eventId);
    const campaignDate = eventDate(event);
    const historyStart = academicYearStart(campaignDate);
    const ticketHolders = new Map();
    for (const ticket of event.guestList || []) {
      if (!guestTicket(ticket)) continue;
      const email = normalizeCampaignEmail(ticket.email);
      if (!ticketHolders.has(email)) ticketHolders.set(email, ticket);
    }
    if (ticketHolders.size > MAX_RECIPIENTS) throw new HttpError("This guest list is too large to review. Contact an administrator.", 422);
    const emails = [...ticketHolders.keys()].sort();
    if (!emails.length) return { event, recipients: [], priorCount: 0, savingsTotalCents: 0 };
    const [marketing, members, alumni, history] = await Promise.all([
      MarketingModel.find({ email: { $in: emails } }).select("email city unsubscribed consent").lean(),
      MemberModel.find({ $expr: { $in: [{ $toLower: { $trim: { input: "$email" } } }, emails] } })
        .select("email").lean(),
      AlumniModel.find({ $expr: { $in: [{ $toLower: { $trim: { input: "$email" } } }, emails] } })
        .select("email").lean(),
      EventModel.find({ $or: [
        { date: { $gte: historyStart, $lte: campaignDate } },
        { correctedDate: { $gte: historyStart, $lte: campaignDate } },
      ] }).select("_id title date correctedDate status hidden region product isFree isMemberFree ticketLink guestList.email guestList.type guestList.userId guestList.memberPriceApplied guestList.refunded poster folder archiveCleanupCompletedAt mediaRetainedAt mediaCleanupAt").limit(MAX_HISTORY_EVENTS + 1).lean(),
    ]);
    if (history.length > MAX_HISTORY_EVENTS) throw new HttpError("Too many events to calculate this academic year. Contact an administrator.", 422);
    const consent = new Set(marketing.filter(row => row.consent?.granted === true && !row.unsubscribed).map(row => normalizeCampaignEmail(row.email)));
    const optOut = new Set(marketing.filter(row => row.unsubscribed).map(row => normalizeCampaignEmail(row.email)));
    const existingAccounts = new Set([...members, ...alumni].map(row => normalizeCampaignEmail(row.email)));
    const recipients = emails.filter(email => consent.has(email) && !optOut.has(email) && !existingAccounts.has(email)).map(email => {
      const eventSavings = [];
      for (const past of history) {
        const date = eventDate(past);
        if (!Number.isFinite(date.getTime()) || date < historyStart || date > campaignDate ||
          past.hidden || ["draft", "cancelled", "canceled"].includes(past.status)) continue;
        const each = standardTicketSavingsCents(past);
        if (!each) continue;
        const tickets = (past.guestList || []).filter(ticket => guestTicket(ticket) && normalizeCampaignEmail(ticket.email) === email).length;
        if (tickets) eventSavings.push({ title: past.title, tickets, savingsCents: each * tickets,
          date: formatEventEmailDate(past), poster: availableEventPoster(past) });
      }
      eventSavings.sort((a, b) => a.title.localeCompare(b.title));
      const ticket = ticketHolders.get(email);
      const { name, surname } = splitName(ticket.name);
      const marketingRegion = marketing.filter(row => normalizeCampaignEmail(row.email) === email).map(row => regionFromCity(row.city)).find(Boolean);
      const region = REGIONS.includes(event.region) ? event.region : marketingRegion ||
        REGIONS.find(candidate => history.some(past => past.region === candidate && past.guestList?.some(row => normalizeCampaignEmail(row.email) === email))) || "amsterdam";
      const phone = /^\+?[\d\s()-]{8,40}$/.test(ticket.phone || "") ? ticket.phone : "";
      return { email, name, surname, phone, region, eventSavings,
        totalCents: eventSavings.reduce((sum, item) => sum + item.savingsCents, 0) };
    });
    const priorCampaign = includePrior ? null : await CampaignModel.findOne({ key: campaignHash([String(eventId), KIND]) }).lean();
    const pending = priorCampaign ? [] : recipients;
    const priorCount = priorCampaign ? recipients.length : 0;
    return { event, recipients: pending, priorCount,
      savingsTotalCents: pending.reduce((sum, recipient) => sum + recipient.totalCents, 0) };
  }
  const fingerprint = result => campaignHash([String(result.event._id), result.event.title, eventDate(result.event),
    result.recipients.map(recipient => [recipient.email, recipientHash(recipient)])]);
  async function preview(eventId, _options, actorId) {
    const result = await inspect(eventId);
    const expiresAt = now().getTime() + 10 * 60000;
    const example = result.recipients[0];
    return { title: result.event.title, kind: KIND, audience: "guests", regions: [result.event.region],
      counts: { members: 0, guests: result.recipients.length }, total: result.recipients.length,
      excludedDuplicates: result.priorCount, savingsTotalCents: result.savingsTotalCents,
      blocked: false, warnings: [], promoCodes: [],
      previews: [{ audience: "guests", ...buildGuestSavingsEmail({ totalCents: example?.totalCents || 0,
        eventSavings: example?.eventSavings || [], region: result.event.region,
        signupUrl: "https://bulgariansociety.nl/signup" }) }],
      review: { expiresAt, signature: sign([actorId, expiresAt, fingerprint(result)]) } };
  }
  async function confirm(eventId, input, actorId) {
    if (!uuid.test(input.requestId || "")) throw new HttpError("A campaign request ID is required.", 422);
    const existing = await CampaignModel.findById(input.requestId).lean();
    if (existing) {
      if (String(existing.eventId) !== String(eventId) || existing.createdBy !== actorId || existing.kind !== KIND) throw new HttpError("This request ID was already used.", 409);
      return existing;
    }
    const result = await inspect(eventId);
    if (!Number.isSafeInteger(input.review?.expiresAt) || input.review.expiresAt <= now().getTime() ||
      !same(input.review.signature, sign([actorId, input.review.expiresAt, fingerprint(result)]))) throw new HttpError("The campaign has changed or the review expired. Review it again before sending.", 409);
    if (!result.recipients.length) throw new HttpError("No eligible guest ticket holders remain.", 409);
    const key = campaignHash([String(eventId), KIND]);
    try {
      return await CampaignModel.findOneAndUpdate({ key }, { $setOnInsert: {
        _id: input.requestId, key, eventId, kind: KIND, audience: "guests", version: VERSION, createdBy: actorId,
        createdAt: now(), status: "queued", total: result.recipients.length,
        recipients: result.recipients.map(recipient => ({ email: recipient.email, audience: "guests", reviewHash: recipientHash(recipient) })),
      } }, { upsert: true, new: true });
    } catch (error) { if (error.code === 11000) return CampaignModel.findOne({ key }); throw error; }
  }
  async function processCampaign(campaign) {
    const acquiredAt = now();
    const claimed = await CampaignModel.findOneAndUpdate({ _id: campaign._id, status: { $in: ["queued", "sending"] },
      $or: [{ leaseUntil: null }, { leaseUntil: { $lte: acquiredAt } }] },
    { $set: { status: "sending", leaseUntil: new Date(+acquiredAt + 30 * 60_000) } }, { new: true }).lean();
    if (!claimed) return;
    campaign = claimed;
    try {
      if (campaign.retryAt && new Date(campaign.retryAt) > now()) return;
    let result;
    const counts = { accepted: campaign.accepted || 0, skipped: campaign.skipped || 0, failed: campaign.failed || 0 };
    const finish = async status => {
      const completedAt = now();
      await recordEventMailHistory({ EventModel, campaign, status, completedAt, counts });
      await CampaignModel.updateOne({ _id: campaign._id }, { $set: { status, completedAt, ...counts },
        $unset: { recipients: 1, retryAt: 1, attempts: 1 } });
    };
    try { result = await inspect(campaign.eventId, { includePrior: true }); }
    catch (error) {
      if (error.statusCode !== 404 && error.statusCode !== 409) throw error;
      await finish("stopped");
      return;
    }
    if (campaign.status === "queued") await CampaignModel.updateOne({ _id: campaign._id }, { $set: { status: "sending" } });
    let cursor = campaign.cursor || 0;
    let attempts = campaign.attempts || 0;
    for (let batch = 0; batch < 10 && cursor < (campaign.recipients || []).length; batch++) {
      const entry = campaign.recipients[cursor];
      let outcome = "skipped";
      try {
        result = await inspect(campaign.eventId, { includePrior: true });
        const recipient = result.recipients.find(item => item.email === entry.email);
        if (recipient && entry.reviewHash === recipientHash(recipient)) {
          const signupUrl = makeLink(recipient);
          const variables = buildGuestSavingsTemplateVariables({ ...recipient, signupUrl });
          const bulk = { batchId: campaign._id, batchType: KIND, totalRecipients: campaign.total,
            source: "bgsnl-event-campaigns", sourceId: String(campaign.eventId), audience: "guests" };
          const digest = campaignDeliveryKey(campaign.eventId, KIND, VERSION, entry.email);
          const operationId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
          await send(GUEST_SAVINGS_TEMPLATE, entry.email, variables, { operationId, bulk });
          outcome = "accepted";
        }
      } catch {
        attempts++;
        if (attempts < 4) {
          await CampaignModel.updateOne({ _id: campaign._id }, { $set: { attempts, retryAt: new Date(+now() + attempts * 60_000) } });
          return;
        }
        outcome = "failed";
      }
      cursor++;
      attempts = 0;
      counts[outcome]++;
      await CampaignModel.updateOne({ _id: campaign._id }, { $set: { cursor, attempts, ...counts }, $unset: { retryAt: 1 } });
    }
    if (cursor >= (campaign.recipients || []).length) await finish(counts.failed ? "completed-with-errors" : "completed");
    } finally {
      await CampaignModel.updateOne({ _id: campaign._id }, { $unset: { leaseUntil: 1 } });
    }
  }
  return { inspect, preview, confirm, processCampaign };
}
