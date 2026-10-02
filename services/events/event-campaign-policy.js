import { createHash } from "node:crypto";
import { eventAnnouncementRegions } from "../../util/config/nearby-regions.js";
import { resolveEventTicketPricing } from "../main-services/event-action-service.js";

export const CAMPAIGN_KINDS = ["announcement", "last-chance", "limited-offer"];
export const CAMPAIGN_AUDIENCES = ["members", "guests", "both"];
export const normalizeCampaignEmail = value => String(value || "").trim().toLowerCase();
export const campaignHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const campaignRegions = event => eventAnnouncementRegions(event?.region);
export const campaignContentHash = event => campaignHash([event.title, event.description, event.text, event.region, event.slug,
  event.correctedDate || event.date, event.location, event.product, event.promotion, event.earlyBird, event.isFree, event.isMemberFree, event.memberOnly]);
const CITY_ALIASES = {
  breda_tilburg: ["breda", "tilburg", "breda-tilburg", "breda tilburg"],
  leiden_hague: ["leiden", "the hague", "den haag", "leiden-the hague", "leiden the hague"],
};
export const campaignCities = event => campaignRegions(event).flatMap(region => [region, ...(CITY_ALIASES[region] || [])]);

export function campaignAvailability(event, now = new Date()) {
  const sold = event?.guestList?.length || 0; // Same capacity convention as ticket checkout.
  const limit = Number(event?.ticketLimit);
  const warnings = [];
  if (!event || event.hidden || event.status !== "opened" || !(new Date(event.correctedDate || event.date) > now)) warnings.push("This event is not public and upcoming.");
  if (event?.isSaleClosed || !(new Date(event?.ticketTimer) > now)) warnings.push("Ticket sales are closed. Reopen sales before sending a campaign.");
  if (!Number.isFinite(limit) || limit <= sold) warnings.push("The ticket limit has been reached. No campaign will be sent.");
  if (event?.ticketLink) warnings.push("External ticket sales cannot be checked for existing buyers. Campaigns are unavailable for this event.");
  if (!campaignRegions(event).length) warnings.push("This event has no configured regional audience.");
  const blocked = warnings.length > 0;
  if (!blocked && sold / limit >= 0.9) warnings.push(`Tickets are nearly sold out: ${sold} of ${limit} places are taken.`);
  return { blocked, warnings, sold, limit, remaining: Math.max(0, limit - sold) };
}

export function alreadyHasEventTicket(event, recipient) {
  const ids = new Set([recipient.member?._id, recipient.member?.id, ...(recipient.member?.accountAliases || [])].filter(Boolean).map(String));
  return (event.guestList || []).some(ticket => normalizeCampaignEmail(ticket.email) === normalizeCampaignEmail(recipient.email) || ids.has(String(ticket.userId)));
}

export function campaignOffer(event, { now = new Date(), promoCode = "" } = {}) {
  const pricing = resolveEventTicketPricing(event, { now });
  const promo = (event.product?.promoCodes || []).find(item => item.code === promoCode && item.active !== false && !item.exhausted &&
    (!item.timeLimit || new Date(item.timeLimit) > now) && (!item.useLimit || Number(item.redeemedBefore || 0) < item.useLimit));
  const tiers = Object.fromEntries(["guest", "member", "activeMember"].map(tier => [tier,
    event.isFree || (tier !== "guest" && event.isMemberFree) ? 0 : pricing.tiers[tier]?.price ?? (tier === "activeMember" ? pricing.tiers.member?.price : undefined)]));
  return { stage: pricing.stage, tiers, promotion: Object.fromEntries(Object.entries(pricing.tiers).map(([key, value]) => [key, value.discount || 0])),
    promo: promo ? { code: promo.code, discount: promo.discount, discountType: promo.discountType,
      audiences: promo.audiences || ["guest", "member"], minAmount: promo.minAmount, timeLimit: promo.timeLimit, useLimit: promo.useLimit } : null };
}

// Announcement and reminder delivery keys never change when an event is edited.
// Offer keys change only with customer-facing economics, not generated price IDs.
export const campaignVersion = (event, kind, options) => kind === "limited-offer" ? campaignHash(campaignOffer(event, options)) : "1";
export const campaignDeliveryKey = (eventId, kind, version, email) => campaignHash([String(eventId), kind, version, normalizeCampaignEmail(email)]);

export function lastChanceDue(event, now = new Date()) {
  const remaining = new Date(event.correctedDate || event.date).getTime() - now.getTime();
  // Poll each minute; allow one hour of downtime recovery, never send a late
  // catch-up blast just before doors open.
  return remaining <= 24 * 3600000 && remaining > 23 * 3600000 && !campaignAvailability(event, now).blocked;
}
