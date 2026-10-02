import { HOME_URL, ACCESS_4 } from "../../util/config/defines.js";
import { eventPageUrl, eventPurchaseUrl } from "./member-event-links.js";
import { campaignOffer } from "./event-campaign-policy.js";

export const EVENT_CAMPAIGN_TEMPLATE = "59f51c9c-88e0-49bc-9e62-b14c8aa4a71d";
const escape = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const plain = value => String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const money = value => Number.isFinite(Number(value)) && value != null ? (Number(value) === 0 ? "Free" : new Intl.NumberFormat("en-NL", { style: "currency", currency: "EUR" }).format(value)) : "See event for prices";

export function buildEventCampaignEmail({ event, recipient, kind, promoCode, ticketUrl, now = new Date() }) {
  const member = recipient.audience === "members";
  const tier = member ? recipient.member?.roles?.some(role => ACCESS_4.includes(role)) ? "activeMember" : "member" : "guest";
  const offer = campaignOffer(event, { now, promoCode });
  const title = plain(event.title);
  const heading = kind === "last-chance" ? `Last chance to book: ${title}` : kind === "limited-offer" ? `A ticket offer for ${title}` : `You're invited: ${title}`;
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", dateStyle: "full", timeStyle: "short" }).format(new Date(event.correctedDate || event.date));
  const banners = [];
  if (offer.stage === "earlyBird" && !(tier !== "guest" && event.earlyBird?.excludeMembers)) banners.push("Early-bird tickets are available while the offer lasts.");
  if (offer.promotion[tier] > 0) banners.push(`${offer.promotion[tier]}% off your ticket is included in the displayed price.`);
  if (offer.promo?.audiences.includes(tier)) banners.push(`Use code ${offer.promo.code} for ${Number(offer.promo.discountType) === 2 ? `${offer.promo.discount}%` : money(offer.promo.discount)} off${offer.promo.minAmount ? ` on orders from ${money(offer.promo.minAmount)}` : ""}${offer.promo.timeLimit ? ` before ${new Date(offer.promo.timeLimit).toLocaleDateString("en-GB", { timeZone: "Europe/Amsterdam" })}` : ""}. Availability and eligibility are checked at checkout.`);
  if (kind === "limited-offer" && !banners.length) banners.push(`Your current ticket price: ${money(offer.tiers[tier])}.`);
  const membership = "Become a member for member ticket prices and one-click checkout on eligible events.";
  const url = ticketUrl || (member ? eventPageUrl(event) : eventPurchaseUrl(event));
  const price = money(offer.tiers[tier]);
  const description = plain(event.description || event.text).slice(0, 1600);
  const link = (href, label) => `<a href="${escape(href)}" style="display:inline-block;background:#017363;color:#ffffff;border-radius:8px;padding:14px 20px;font-weight:bold;text-decoration:none;">${escape(label)}</a>`;
  const banner = text => `<p style="padding:16px;background:#f0f5f1;border-radius:8px;color:#173f35;">${escape(text)}</p>`;
  return {
    subject: heading,
    html: `<h1 style="font-size:26px;line-height:1.25;color:#173f35;">${escape(heading)}</h1><p>Hi ${escape(recipient.member?.name || "there")},</p><p><strong>${escape(date)} (Amsterdam time)</strong><br>${escape(event.location)}</p><p>${escape(description)}</p>${banners.map(banner).join("")}<p>Your ticket price: <strong>${escape(price)}</strong></p><p>${link(url, offer.tiers[tier] === 0 ? "Get your free ticket" : "Get your ticket")}</p><p><a href="${escape(eventPageUrl(event))}" style="color:#017363;text-decoration:underline;">View event details</a></p>${!member ? `${banner(membership)}<p>${link(`${HOME_URL}/signup`, "Become a member")}</p>` : ""}<p>Prices and availability are checked when you book. Already booked? No further action is needed.</p>`,
    text: [heading, `Hi ${recipient.member?.name || "there"},`, date, event.location, description, ...banners,
      `Your ticket price: ${price}`, `Get your ticket: ${url}`, `View event: ${eventPageUrl(event)}`,
      ...(!member ? [membership, `Become a member: ${HOME_URL}/signup`] : [])].join("\n\n"),
  };
}
