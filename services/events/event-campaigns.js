import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import Event from "../../models/Event.js";
import MemberUser from "../../models/MemberUser.js";
import MarketingEmail from "../../models/MarketingEmail.js";
import Campaign, { EventEmailDelivery } from "../../models/EventEmailCampaign.js";
import HttpError from "../../models/Http-error.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { queueDomakinTemplateEmail } from "../background-services/domakin-mailer.js";
import { createMemberEventLink, isCurrentEventMember } from "./member-event-links.js";
import { buildEventCampaignEmail, EVENT_CAMPAIGN_TEMPLATE } from "./event-campaign-email.js";
import { CAMPAIGN_KINDS, CAMPAIGN_AUDIENCES, campaignHash, campaignContentHash, campaignRegions, campaignCities, campaignAvailability, campaignVersion,
  campaignDeliveryKey, normalizeCampaignEmail, alreadyHasEventTicket, campaignOffer, lastChanceDue } from "./event-campaign-policy.js";

const MAX_RECIPIENTS = 20000;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createEventCampaignService({ EventModel = Event, MemberModel = MemberUser, MarketingModel = MarketingEmail,
  CampaignModel = Campaign, DeliveryModel = EventEmailDelivery, now = () => new Date(),
  secret = () => process.env.EVENT_CAMPAIGN_REVIEW_SECRET || process.env.JWT_STRING,
  makeLink = createMemberEventLink, send = queueDomakinTemplateEmail } = {}) {
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
  async function eligible(event, audience, date, onlyEmails) {
    // Consent is mandatory for members too. Never infer consent from purchase.
    const entries = await MarketingModel.find({ city: { $in: campaignCities(event) }, unsubscribed: false, "consent.granted": true,
      ...(onlyEmails ? { email: { $in: onlyEmails } } : {}) }).select("email").limit(MAX_RECIPIENTS + 1).lean();
    if (entries.length > MAX_RECIPIENTS) throw new HttpError("This regional audience is too large to review. Contact an administrator.", 422);
    const emails = [...new Set(entries.map(entry => normalizeCampaignEmail(entry.email)))].filter(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    if (!emails.length) return [];
    const [optOuts, members] = await Promise.all([
      MarketingModel.find({ email: { $in: emails }, unsubscribed: true }).select("email").lean(),
      MemberModel.find({ $expr: { $in: [{ $toLower: { $trim: { input: "$email" } } }, emails] } })
        .select("_id email name region status roles expireDate accountAliases").lean(),
    ]);
    const blocked = new Set(optOuts.map(entry => normalizeCampaignEmail(entry.email)));
    const currentMembers = new Map(members.filter(member => isCurrentEventMember(member, date.getTime())).map(member => [normalizeCampaignEmail(member.email), member]));
    return emails.sort().flatMap(email => {
      if (blocked.has(email)) return [];
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
    const candidates = (await eligible(event, options.audience, date)).filter(recipient => !(options.kind === "announcement" && event.memberAnnouncementCompletedAt && recipient.audience === "members"));
    const keys = candidates.map(recipient => campaignDeliveryKey(eventId, options.kind, version, recipient.email));
    const prior = keys.length ? await DeliveryModel.find({ _id: { $in: keys } }).select("_id").lean() : [];
    const used = new Set(prior.map(row => row._id));
    const recipients = candidates.filter(recipient => !used.has(campaignDeliveryKey(eventId, options.kind, version, recipient.email)));
    const previews = [...new Set(recipients.map(recipient => recipient.audience))].map(audience => ({ audience,
      ...buildEventCampaignEmail({ event, recipient: { audience }, kind: options.kind, promoCode: options.promoCode, now: date }) }));
    const data = { eventId: String(eventId), title: event.title, kind: options.kind, audience: options.audience, promoCode: options.promoCode || "", version,
      regions: campaignRegions(event), counts: { members: recipients.filter(r => r.audience === "members").length, guests: recipients.filter(r => r.audience === "guests").length },
      total: recipients.length, excludedDuplicates: prior.length, ...availability, previews,
      promoCodes: (event.product?.promoCodes || []).filter(promo => campaignOffer(event, { now: date, promoCode: promo.code }).promo).map(promo => promo.code) };
    // Any event, economics, audience or availability change requires review.
    const fingerprint = campaignHash([data, recipients.map(({ email, audience }) => [email, audience])]);
    return { event, recipients, data, fingerprint };
  }
  async function preview(eventId, options, actorId) {
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
    const date = now();
    let event;
    try { event = await getEvent(campaign.eventId); }
    catch (error) {
      if (error.statusCode !== 404) throw error;
      await CampaignModel.updateOne({ _id: campaign._id }, { $set: { status: "stopped", completedAt: date }, $unset: { recipients: 1 } });
      return;
    }
    if (campaignAvailability(event, date).blocked || campaign.contentHash !== campaignContentHash(event) || campaign.version !== campaignVersion(event, campaign.kind, { now: date, promoCode: campaign.promoCode })) {
      await CampaignModel.updateOne({ _id: campaign._id }, { $set: { status: "stopped", completedAt: date }, $unset: { recipients: 1 } });
      return;
    }
    // Crash-safe seeding: delivery _id is global to event/kind/offer/email,
    // independent of region, audience selection, campaign run or process.
    if (campaign.status === "queued") {
      for (const recipient of campaign.recipients) {
        const key = campaignDeliveryKey(event._id, campaign.kind, campaign.version, recipient.email);
        try { await DeliveryModel.updateOne({ _id: key }, { $setOnInsert: { _id: key, campaignId: campaign._id, eventId: event._id,
          kind: campaign.kind, version: campaign.version, ...recipient, operationId: randomUUID(), status: "pending", attempts: 0 } }, { upsert: true }); }
        catch (error) { if (error.code !== 11000) throw error; }
      }
      await CampaignModel.updateOne({ _id: campaign._id, status: "queued" }, { $set: { status: "sending" } });
    }
    for (let index = 0; index < 10; index++) {
      const time = now();
      const delivery = await DeliveryModel.findOneAndUpdate({ campaignId: campaign._id, attempts: { $lt: 4 }, $or: [
        { status: "pending", $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: time } }] },
        { status: "sending", leaseUntil: { $lte: time } },
      ] }, { $set: { status: "sending", leaseUntil: new Date(time.getTime() + 300000) }, $inc: { attempts: 1 } }, { new: true }).lean();
      if (!delivery) break;
      try {
        event = await getEvent(campaign.eventId);
        const eligibleNow = await eligible(event, campaign.audience, now(), [delivery.email]);
        const recipient = eligibleNow.find(item => item.email === delivery.email && item.audience === delivery.audience);
        if (!recipient || campaignAvailability(event, now()).blocked || campaign.contentHash !== campaignContentHash(event) || campaign.version !== campaignVersion(event, campaign.kind, { now: now(), promoCode: campaign.promoCode })) {
          await DeliveryModel.updateOne({ _id: delivery._id }, { $set: { status: "skipped", reason: "Eligibility or offer changed", finishedAt: now() } });
          continue;
        }
        if (!delivery.variables) {
          delivery.variables = buildEventCampaignEmail({ event, recipient, kind: campaign.kind, promoCode: campaign.promoCode,
            ticketUrl: recipient.member ? makeLink(event, recipient.member) : undefined, now: now() });
          delivery.bulk = { batchId: campaign._id, batchType: `event-${campaign.kind}`, totalRecipients: campaign.total, source: "bgsnl-event-campaigns", sourceId: String(event._id), audience: campaign.audience };
          await DeliveryModel.updateOne({ _id: delivery._id }, { $set: { variables: delivery.variables, bulk: delivery.bulk } });
        }
        await send(EVENT_CAMPAIGN_TEMPLATE, delivery.email, delivery.variables, { operationId: delivery.operationId, bulk: delivery.bulk });
        await DeliveryModel.updateOne({ _id: delivery._id }, { $set: { status: "accepted", finishedAt: now() } });
      } catch {
        await DeliveryModel.updateOne({ _id: delivery._id }, { $set: { status: delivery.attempts >= 4 ? "failed" : "pending",
          reason: "Delivery not confirmed", nextAttemptAt: new Date(now().getTime() + delivery.attempts * 60000) } });
      }
    }
    // A crash on the final attempt must not leave a permanently sending row.
    await DeliveryModel.updateMany({ campaignId: campaign._id, status: "sending", attempts: { $gte: 4 }, leaseUntil: { $lte: now() } }, { $set: { status: "failed", reason: "Final attempt not confirmed" } });
    if (!await DeliveryModel.exists({ campaignId: campaign._id, status: { $in: ["pending", "sending"] } })) {
      const failed = await DeliveryModel.exists({ campaignId: campaign._id, status: "failed" });
      await CampaignModel.updateOne({ _id: campaign._id }, { $set: { status: failed ? "completed-with-errors" : "completed", completedAt: now() }, $unset: { recipients: 1 } });
    }
  }
  async function tick() {
    const date = now();
    const lower = new Date(date.getTime() + 23 * 3600000), upper = new Date(date.getTime() + 24 * 3600000);
    const due = await EventModel.find({ status: "opened", hidden: { $ne: true }, isSaleClosed: { $ne: true },
      $or: [{ correctedDate: { $gt: lower, $lte: upper } }, { correctedDate: null, date: { $gt: lower, $lte: upper } }] }).lean();
    const safeRun = async action => {
      try { await action(); }
      catch { logOperationalError("worker.event-campaign", new Error("An event campaign could not be processed; it remains available for retry.")); }
    };
    for (const event of due) await safeRun(() => queueAutomatic(event));
    // Replace the old publication worker while campaigns are enabled, so both
    // paths share consent, buyer exclusions and durable deduplication.
    const published = await EventModel.find({ memberAnnouncementQueuedAt: { $lte: date }, memberAnnouncementCompletedAt: { $exists: false } }).limit(10).lean();
    for (const event of published) {
      await safeRun(async () => {
        const options = { kind: "announcement", audience: "members" };
        const result = await inspect(event._id, options);
        if (!result.data.blocked && result.data.total) await persist(event._id, options, result, "publication");
        // Match the legacy worker: a closed/past/full publication is consumed,
        // not allowed to starve later announcements indefinitely.
        await EventModel.updateOne({ _id: event._id }, { $set: { memberAnnouncementCompletedAt: date } });
      });
    }
    const campaigns = await CampaignModel.find({ status: { $in: ["queued", "sending"] } }).sort({ createdAt: 1 }).limit(10).lean();
    for (const campaign of campaigns) await safeRun(() => processCampaign(campaign));
  }
  return { preview, confirm, inspect, eligible, queueAutomatic, processCampaign, tick };
}
