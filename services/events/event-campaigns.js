import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import Event from "../../models/Event.js";
import MemberUser from "../../models/MemberUser.js";
import AlumniUser from "../../models/AlumniUser.js";
import MarketingEmail from "../../models/MarketingEmail.js";
import GuestMarketingEmail from "../../models/GuestMarketingEmail.js";
import Campaign from "../../models/EventEmailCampaign.js";
import HttpError from "../../models/Http-error.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { queueDomakinTemplateEmail } from "../background-services/domakin-mailer.js";
import { jobFailurePolicy } from "../monitoring/job-failure-policy.js";
import { createMemberEventLink, isCurrentEventMember } from "./member-event-links.js";
import { createGuestSignupLink } from "./guest-signup-prefill.js";
import { buildEventCampaignEmail, EVENT_CAMPAIGN_TEMPLATE } from "./event-campaign-email.js";
import { createGuestSavingsCampaignService } from "./guest-savings-campaign.js";
import { recordEventMailHistory } from "./event-mail-history.js";
import { academicYearLabel } from "../../util/config/academic-year.js";
import { CAMPAIGN_KINDS, CAMPAIGN_AUDIENCES, campaignHash, campaignContentHash, campaignRegions, campaignCities, campaignAvailability, campaignVersion,
  campaignDeliveryKey, normalizeCampaignEmail, alreadyHasEventTicket, campaignOffer, lastChanceDue } from "./event-campaign-policy.js";

const MAX_RECIPIENTS = 20000;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createEventCampaignService({ EventModel = Event, MemberModel = MemberUser, AlumniModel = AlumniUser, MarketingModel = MarketingEmail,
  GuestModel = GuestMarketingEmail,
  CampaignModel = Campaign, now = () => new Date(),
  secret = () => process.env.EVENT_CAMPAIGN_REVIEW_SECRET || process.env.JWT_STRING,
  makeLink = createMemberEventLink, makeSignupLink = createGuestSignupLink, makeSavingsLink, send = queueDomakinTemplateEmail,
  notifyFailure = (campaign, attempts) => jobFailurePolicy.queueFailure("event-campaign", `${campaign.kind}-delivery`, campaign._id, attempts) } = {}) {
  const savings = createGuestSavingsCampaignService({ EventModel, MemberModel, AlumniModel, MarketingModel, CampaignModel, now, secret,
    ...(makeSavingsLink ? { makeLink: makeSavingsLink } : {}), send, notifyFailure });
  const sign = data => {
    const key = secret();
    if (!key || key.length < 32) throw new HttpError("Campaign review is not configured. Contact an administrator.", 503);
    return createHmac("sha256", key).update(JSON.stringify(data)).digest("hex");
  };
  const getEvent = async id => {
    const event = await EventModel.findById(id).lean();
    if (!event) throw new HttpError("This event no longer exists.", 404);
    return event;
  };
  const validate = ({ kind, audience, promoCode = "" }) => {
    if (!CAMPAIGN_KINDS.includes(kind) || !CAMPAIGN_AUDIENCES.includes(audience) || typeof promoCode !== "string" || promoCode.length > 80) throw new HttpError("Choose a valid campaign and audience.", 422);
  };
  async function eligible(event, audience, date, onlyEmails, kind) {
    // Consent is mandatory for members too. Never infer consent from purchase.
    const entries = await MarketingModel.find({ city: { $in: campaignCities(event) }, unsubscribed: false, "consent.granted": true,
      ...(onlyEmails ? { email: { $in: onlyEmails } } : {}) }).select("email").limit(MAX_RECIPIENTS + 1).lean();
    if (entries.length > MAX_RECIPIENTS) throw new HttpError("This regional audience is too large to review. Contact an administrator.", 422);
    const validEmail = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const regionalEmails = new Set(entries.map(entry => normalizeCampaignEmail(entry.email)).filter(validEmail));
    const guestCandidates = new Set();
    if (kind === "announcement" && audience !== "members" && !event.memberOnly) {
      const guestRows = await GuestModel.find({ academicYear: academicYearLabel(date), region: { $in: campaignRegions(event) },
        ...(onlyEmails ? { email: { $in: onlyEmails } } : {}) }).select("email").limit(MAX_RECIPIENTS + 1).lean();
      if (guestRows.length > MAX_RECIPIENTS) throw new HttpError("This regional audience is too large to review. Contact an administrator.", 422);
      for (const email of guestRows.map(row => normalizeCampaignEmail(row.email)).filter(validEmail)) guestCandidates.add(email);
    }
    const emails = [...new Set([...regionalEmails, ...guestCandidates])].sort();
    if (emails.length > MAX_RECIPIENTS) throw new HttpError("This regional audience is too large to review. Contact an administrator.", 422);
    if (!emails.length) return [];
    const [marketingRows, members, alumni] = await Promise.all([
      MarketingModel.find({ email: { $in: emails } }).select("email unsubscribed consent").lean(),
      MemberModel.find({ $expr: { $in: [{ $toLower: { $trim: { input: "$email" } } }, emails] } })
        .select("_id email name region status roles expireDate accountAliases").lean(),
      AlumniModel.find({ $expr: { $in: [{ $toLower: { $trim: { input: "$email" } } }, [...guestCandidates]] } })
        .select("email").lean(),
    ]);
    const blocked = new Set(marketingRows.filter(row => row.unsubscribed).map(row => normalizeCampaignEmail(row.email)));
    const consented = new Set(marketingRows.filter(row => row.consent?.granted === true && !row.unsubscribed)
      .map(row => normalizeCampaignEmail(row.email)));
    const guestAccounts = new Set([...members, ...alumni].map(account => normalizeCampaignEmail(account.email)));
    const currentMembers = new Map(members.filter(member => isCurrentEventMember(member, date.getTime())).map(member => [normalizeCampaignEmail(member.email), member]));
    return emails.flatMap(email => {
      if (blocked.has(email)) return [];
      if (!regionalEmails.has(email) && (!guestCandidates.has(email) || !consented.has(email) || guestAccounts.has(email))) return [];
      const member = currentMembers.get(email);
      const recipient = { email, audience: member ? "members" : "guests", ...(member ? { member } : {}) };
      if ((audience !== "both" && recipient.audience !== audience) || (event.memberOnly && !member) || alreadyHasEventTicket(event, recipient)) return [];
      // Existing publication announcements have no per-address history. Be
      // conservative: never resend their announcement to the member audience.
      return [recipient];
    });
  }
  async function inspect(eventId, options) {
    validate(options);
    const date = now();
    const event = await getEvent(eventId);
    const availability = campaignAvailability(event, date);
    const offer = campaignOffer(event, { now: date, promoCode: options.promoCode });
    if (options.promoCode && !offer.promo) throw new HttpError("That promo code is no longer available. Review the campaign again.", 409);
    const version = campaignVersion(event, options.kind, { now: date, promoCode: options.promoCode });
    const candidates = (await eligible(event, options.audience, date, undefined, options.kind)).filter(recipient => !(options.kind === "announcement" && event.memberAnnouncementCompletedAt && recipient.audience === "members"));
    const priorCampaigns = await CampaignModel.find({ eventId, kind: options.kind, version }).lean();
    const blockedAudiences = new Set(priorCampaigns.flatMap(campaign => campaign.audience === "both" ? ["members", "guests"] : [campaign.audience]));
    const recipients = candidates.filter(recipient => !blockedAudiences.has(recipient.audience));
    const excludedDuplicates = candidates.length - recipients.length;
    const previews = [...new Set(recipients.map(recipient => recipient.audience))].map(audience => ({ audience,
      ...buildEventCampaignEmail({ event, recipient: { audience }, kind: options.kind, promoCode: options.promoCode, now: date }) }));
    const data = { eventId: String(eventId), title: event.title, kind: options.kind, audience: options.audience, promoCode: options.promoCode || "", version,
      regions: campaignRegions(event), counts: { members: recipients.filter(r => r.audience === "members").length, guests: recipients.filter(r => r.audience === "guests").length },
      total: recipients.length, excludedDuplicates, ...availability, previews,
      promoCodes: (event.product?.promoCodes || []).filter(promo => campaignOffer(event, { now: date, promoCode: promo.code }).promo).map(promo => promo.code) };
    // Any event, economics, audience or availability change requires review.
    const fingerprint = campaignHash([data, recipients.map(({ email, audience }) => [email, audience])]);
    return { event, recipients, data, fingerprint };
  }
  async function preview(eventId, options, actorId) {
    if (options?.kind === "guest-savings") return savings.preview(eventId, options, actorId);
    const result = await inspect(eventId, options);
    const expiresAt = now().getTime() + 10 * 60000;
    return { ...result.data, review: { expiresAt, signature: sign([actorId, expiresAt, result.fingerprint]) } };
  }
  async function persist(eventId, options, result, createdBy, id = randomUUID()) {
    if (result.data.blocked) throw new HttpError(result.data.warnings[0], 409);
    if (!result.recipients.length) throw new HttpError("No eligible recipients remain. They may have booked, opted out, or already received this campaign.", 409);
    const key = campaignHash([String(eventId), options.kind, result.data.version, options.audience]);
    try {
      return await CampaignModel.findOneAndUpdate({ key }, { $setOnInsert: {
        _id: id, key, eventId, kind: options.kind, audience: options.audience, version: result.data.version,
        promoCode: options.promoCode || "", contentHash: campaignContentHash(result.event), createdBy, createdAt: now(), status: "queued", total: result.recipients.length,
        recipients: result.recipients.map(({ email, audience }) => ({ email, audience })),
      } }, { upsert: true, new: true });
    } catch (error) { if (error.code === 11000) return CampaignModel.findOne({ key }); throw error; }
  }
  async function confirm(eventId, input, actorId) {
    if (input?.kind === "guest-savings") return savings.confirm(eventId, input, actorId);
    if (!uuid.test(input.requestId || "")) throw new HttpError("A campaign request ID is required.", 422);
    const existing = await CampaignModel.findById(input.requestId).lean();
    if (existing) {
      if (String(existing.eventId) !== String(eventId) || existing.createdBy !== actorId || existing.kind !== input.kind || existing.audience !== input.audience || existing.promoCode !== (input.promoCode || "")) throw new HttpError("This request ID was already used.", 409);
      return existing;
    }
    const result = await inspect(eventId, input);
    if (!Number.isSafeInteger(input.review?.expiresAt) || input.review.expiresAt <= now().getTime() ||
      !same(input.review.signature, sign([actorId, input.review.expiresAt, result.fingerprint]))) throw new HttpError("The campaign has changed or the review expired. Review it again before sending.", 409);
    return persist(eventId, input, result, actorId, input.requestId);
  }
  async function queueAutomatic(event) {
    if (!lastChanceDue(event, now())) return null;
    const options = { kind: "last-chance", audience: "both" };
    const result = await inspect(event._id, options);
    return result.data.total && !result.data.blocked ? persist(event._id, options, result, "scheduler") : null;
  }
  async function processCampaign(campaign) {
    if (campaign.kind === "guest-savings") { await savings.processCampaign(campaign); return; }
    const acquiredAt = now();
    const claimed = await CampaignModel.findOneAndUpdate({ _id: campaign._id, status: { $in: ["queued", "sending"] },
      $or: [{ leaseUntil: null }, { leaseUntil: { $lte: acquiredAt } }] },
    { $set: { status: "sending", leaseUntil: new Date(+acquiredAt + 30 * 60_000) } }, { new: true }).lean();
    if (!claimed) return;
    campaign = claimed;
    try {
      if (campaign.retryAt && new Date(campaign.retryAt) > now()) return;
    let event;
    try { event = await getEvent(campaign.eventId); }
    catch (error) {
      if (error.statusCode !== 404) throw error;
      await CampaignModel.updateOne({ _id: campaign._id }, { $set: { status: "stopped", completedAt: now() }, $unset: { recipients: 1 } });
      return;
    }
    const stillValid = () => !campaignAvailability(event, now()).blocked &&
      campaign.contentHash === campaignContentHash(event) &&
      campaign.version === campaignVersion(event, campaign.kind, { now: now(), promoCode: campaign.promoCode });
    const counts = { accepted: campaign.accepted || 0, skipped: campaign.skipped || 0, failed: campaign.failed || 0 };
    const finish = async status => {
      const completedAt = now();
      await recordEventMailHistory({ EventModel, campaign, status, completedAt, counts });
      await CampaignModel.updateOne({ _id: campaign._id }, { $set: { status, completedAt, ...counts },
        $unset: { recipients: 1, retryAt: 1, attempts: 1 } });
    };
    if (!stillValid()) { await finish("stopped"); return; }
    if (campaign.status === "queued") await CampaignModel.updateOne({ _id: campaign._id }, { $set: { status: "sending" } });
    let cursor = campaign.cursor || 0;
    let attempts = campaign.attempts || 0;
    for (let batch = 0; batch < 10 && cursor < (campaign.recipients || []).length; batch++) {
      const entry = campaign.recipients[cursor];
      let outcome = "skipped";
      try {
        event = await getEvent(campaign.eventId);
        if (!stillValid()) { await finish("stopped"); return; }
        const current = await eligible(event, campaign.audience, now(), [entry.email], campaign.kind);
        const recipient = current.find(item => item.email === entry.email && item.audience === entry.audience);
        if (recipient) {
          const variables = buildEventCampaignEmail({ event, recipient, kind: campaign.kind,
            promoCode: campaign.promoCode, ticketUrl: recipient.member ? makeLink(event, recipient.member) : undefined,
            signupUrl: !recipient.member && campaign.kind !== "announcement"
              ? makeSignupLink({ email: recipient.email, region: event.region, name: "", surname: "", phone: "" }) : undefined,
            now: now() });
          const bulk = { batchId: campaign._id, batchType: `event-${campaign.kind}`, totalRecipients: campaign.total,
            source: "bgsnl-event-campaigns", sourceId: String(event._id), audience: campaign.audience };
          const digest = campaignDeliveryKey(event._id, campaign.kind, campaign.version, entry.email);
          const operationId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
          await send(EVENT_CAMPAIGN_TEMPLATE, entry.email, variables, { operationId, bulk });
          outcome = "accepted";
        }
      } catch (error) {
        attempts++;
        logOperationalError("worker.event-campaign-delivery", error);
        if (attempts < 5) {
          await CampaignModel.updateOne({ _id: campaign._id }, { $set: { attempts, retryAt: new Date(+now() + attempts * 60_000) } });
          return;
        }
        await notifyFailure(campaign, attempts);
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
  async function tick() {
    const date = now();
    let failed = 0;
    const upper = new Date(date.getTime() + 24 * 3600000);
    const due = await EventModel.find({ status: "opened", hidden: { $ne: true }, isSaleClosed: { $ne: true },
      $or: [{ correctedDate: { $gt: date, $lte: upper } }, { correctedDate: null, date: { $gt: date, $lte: upper } }] }).lean();
    const safeRun = async action => {
      try { await action(); }
      catch {
        failed++;
        logOperationalError("worker.event-campaign", new Error("An event campaign could not be processed; it remains available for retry."));
      }
    };
    for (const event of due) await safeRun(() => queueAutomatic(event));
    // Replace the old publication worker while campaigns are enabled, so both
    // paths share consent, buyer exclusions and durable deduplication.
    const published = await EventModel.find({ memberAnnouncementQueuedAt: { $lte: date }, memberAnnouncementCompletedAt: { $exists: false } }).limit(10).lean();
    for (const event of published) {
      await safeRun(async () => {
        const options = { kind: "announcement", audience: "both" };
        const result = await inspect(event._id, options);
        if (!result.data.blocked && result.data.total) await persist(event._id, options, result, "publication");
        // Match the legacy worker: a closed/past/full publication is consumed,
        // not allowed to starve later announcements indefinitely.
        await EventModel.updateOne({ _id: event._id }, { $set: { memberAnnouncementCompletedAt: date } });
      });
    }
    const campaigns = await CampaignModel.find({ status: { $in: ["queued", "sending"] } }).sort({ createdAt: 1 }).limit(10).lean();
    for (const campaign of campaigns.filter(item => !item.retryAt || new Date(item.retryAt) <= date)) await safeRun(() => processCampaign(campaign));
    return { failed, noWork: !due.length && !published.length && !campaigns.length };
  }
  return { preview, confirm, inspect, eligible, queueAutomatic, processCampaign, tick };
}
