import { HOME_URL, ACCESS_4 } from "../../util/config/defines.js";
import { formatRegionBadgeLabel } from "../../util/config/region-badges.js";
import { eventPageUrl, eventPurchaseUrl } from "./member-event-links.js";
import { campaignOffer } from "./event-campaign-policy.js";
import { formatEventEmailDate, renderEventEmailPreview, safeEventPosterUrl } from "./event-email-preview.js";

export const EVENT_CAMPAIGN_TEMPLATE = "59f51c9c-88e0-49bc-9e62-b14c8aa4a71d";
const escape = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const plain = value => String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const money = value => Number.isFinite(Number(value)) && value != null ? (Number(value) === 0 ? "Free" : new Intl.NumberFormat("en-NL", { style: "currency", currency: "EUR" }).format(value)) : "See event for prices";
const lastChanceIconUrl = `${HOME_URL}/assets/images/emails/timer-red.png`;
const offerIconUrl = `${HOME_URL}/assets/images/emails/discount.png`;
const memberIconUrl = `${HOME_URL}/assets/images/emails/user-star.png`;

export function buildEventCampaignEmail({ event, recipient, kind, promoCode, ticketUrl, signupUrl, now = new Date() }) {
  const member = recipient.audience === "members";
  const tier = member ? recipient.member?.roles?.some(role => ACCESS_4.includes(role)) ? "activeMember" : "member" : "guest";
  const offer = campaignOffer(event, { now, promoCode });
  const title = plain(event.title);
  const heading = kind === "last-chance" ? "Last chance to book" : kind === "limited-offer" ? `A ticket offer for ${title}` : `You're invited: ${title}`;
  const date = formatEventEmailDate(event);
  const banners = [];
  let promoNotice = "";
  if (offer.stage === "earlyBird" && !(tier !== "guest" && event.earlyBird?.excludeMembers)) banners.push("Early-bird tickets are available while the offer lasts.");
  if (offer.promotion[tier] > 0) banners.push(kind === "announcement" && !member
    ? `${offer.promotion[tier]}% off your ticket is available at checkout.`
    : `${offer.promotion[tier]}% off your ticket is included in the displayed price.`);
  if (offer.promo?.audiences.includes(tier)) {
    promoNotice = `Use code ${offer.promo.code} for ${Number(offer.promo.discountType) === 2 ? `${offer.promo.discount}%` : money(offer.promo.discount)} off${offer.promo.minAmount ? ` on orders from ${money(offer.promo.minAmount)}` : ""}${offer.promo.timeLimit ? ` before ${new Date(offer.promo.timeLimit).toLocaleDateString("en-GB", { timeZone: "Europe/Amsterdam" })}` : ""}. Availability and eligibility are checked at checkout.`;
    banners.push(promoNotice);
  }
  if (kind === "announcement" && !member) {
    const name = plain(recipient.name || "there");
    const purchaseUrl = eventPurchaseUrl(event);
    const viewUrl = eventPageUrl(event);
    const poster = safeEventPosterUrl(event.poster);
    const greeting = `Hi ${name}, there is new event nearby and we would like to invite you.`;
    const action = (href, label, background, color) => `<a href="${escape(href)}" style="display:inline-block;box-sizing:border-box;min-height:44px;padding:13px 22px;border-radius:10px;background:${background};color:${color};font-size:16px;line-height:20px;font-weight:bold;text-decoration:none;text-align:center;white-space:nowrap;">${label}</a>`;
    return {
      subject: `New event: ${title}`,
      html: `<p style="font-size:16px;line-height:1.5;color:#33403a;margin:0 0 18px;">${escape(greeting)}</p>${renderEventEmailPreview({ title, date, poster, region: event.region })}${banners.map(text => `<p style="padding:16px;background:#f0f5f1;border-radius:8px;color:#173f35;">${escape(text)}</p>`).join("")}<table role="presentation" align="center" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;"><tr><td valign="middle" style="padding:0;">${action(viewUrl, "View event", "#edf2ef", "#173f35")}</td><td width="12" aria-hidden="true" style="width:12px;min-width:12px;padding:0;font-size:0;line-height:0;">&nbsp;</td><td valign="middle" style="padding:0;">${action(purchaseUrl, "Get ticket", "#173f35", "#ffffff")}</td></tr></table>`,
      text: [greeting, formatRegionBadgeLabel(event.region), title, date,
        ...(poster ? [`Event poster: ${poster}`] : []), ...banners,
        `View event: ${viewUrl}`, `Get ticket: ${purchaseUrl}`].join("\n\n"),
    };
  }
  const membership = "Become a member for member ticket prices and one-click checkout on eligible events.";
  const url = ticketUrl || (member ? eventPageUrl(event) : eventPurchaseUrl(event));
  const price = money(offer.tiers[tier]);
  const basePriceValue = event.product?.[tier]?.price ?? (tier === "activeMember" ? event.product?.member?.price : undefined);
  const currentPriceValue = offer.tiers[tier];
  const normalPrice = basePriceValue != null && currentPriceValue != null &&
    Number.isFinite(Number(basePriceValue)) && Number.isFinite(Number(currentPriceValue)) &&
    Number(basePriceValue) > Number(currentPriceValue) && !event.isFree ? money(basePriceValue) : "";
  const priceHtml = `<p style="margin:0 0 18px;">Your ticket price: <strong>${escape(price)}</strong>${normalPrice ? ` <del style="margin-left:8px;color:#607168;">${escape(normalPrice)}</del>` : ""}</p>`;
  const priceText = `Your ticket price: ${price}${normalPrice ? ` (normal price ${normalPrice})` : ""}`;
  const description = plain(event.description || event.text).slice(0, 1600);
  const eventPreview = renderEventEmailPreview({ title, date, poster: event.poster, region: event.region });
  const link = (href, label, background = "#017363", color = "#ffffff") => `<a href="${escape(href)}" style="display:block;box-sizing:border-box;min-height:44px;background:${background};color:${color};border-radius:8px;padding:12px 8px;font-size:15px;line-height:20px;font-weight:bold;text-decoration:none;text-align:center;">${escape(label)}</a>`;
  const banner = text => `<p style="padding:16px;background:#f0f5f1;border-radius:8px;color:#173f35;">${escape(text)}</p>`;
  const headingIcon = kind === "last-chance" ? lastChanceIconUrl : kind === "limited-offer" ? offerIconUrl : "";
  const headingColor = kind === "last-chance" ? "#b42318" : "#173f35";
  const headingHtml = headingIcon
    ? `<table role="presentation" align="center" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 20px;"><tr><td width="32" valign="middle" style="width:32px;padding:0 8px 0 0;"><img src="${escape(headingIcon)}" width="24" height="24" alt="" style="display:block;width:24px;height:24px;"></td><td valign="middle" style="padding:0;"><h1 style="margin:0;color:${headingColor};font-size:19px;line-height:1.3;">${escape(heading)}</h1></td></tr></table>`
    : `<h1 style="font-size:26px;line-height:1.25;color:#173f35;">${escape(heading)}</h1>`;
  const greeting = kind === "announcement" ? `<p>Hi ${escape(recipient.member?.name || "there")},</p>` : "";
  const detailsUrl = eventPageUrl(event);
  const actions = `<table class="bgsnl-event-actions" role="presentation" align="center" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:380px;margin:0 auto 20px;border-collapse:separate;"><tr><td width="50%" valign="middle" style="width:50%;padding:0 4px 0 0;vertical-align:middle;">${link(detailsUrl, "View event", "#edf2ef", "#173f35")}</td><td width="50%" valign="middle" style="width:50%;padding:0 0 0 4px;vertical-align:middle;">${link(url, offer.tiers[tier] === 0 ? "Get your free ticket" : "Get your ticket")}</td></tr></table>`;
  const memberSignupUrl = signupUrl || `${HOME_URL}/${encodeURIComponent(event.region)}/signup`;
  const memberInvite = member ? "" : `<table class="bgsnl-member-warning" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#fff3d6" style="width:100%;border-collapse:separate;border-spacing:0;margin:20px 0;background:#fff3d6;border-radius:12px;"><tr><td width="44" valign="top" style="width:44px;padding:16px 0 16px 16px;vertical-align:top;"><img src="${escape(memberIconUrl)}" width="24" height="24" alt="" style="display:block;width:24px;height:24px;"></td><td valign="top" style="padding:16px;color:#352718;font-size:15px;line-height:1.5;vertical-align:top;"><a href="${escape(memberSignupUrl)}" style="color:#674707;font-weight:700;text-decoration:underline;">Become a member</a> for member ticket prices and one-click checkout on eligible events.</td></tr></table>`;
  const extraCopy = kind === "announcement"
    ? `<p>${escape(event.location)}</p><p>${escape(description)}</p>${banners.map(banner).join("")}`
    : promoNotice ? banner(promoNotice) : "";
  return {
    subject: heading,
    html: `${headingHtml}${greeting}${eventPreview}${extraCopy}${priceHtml}${actions}${memberInvite}${kind === "announcement" ? "<p>Prices and availability are checked when you book. Already booked? No further action is needed.</p>" : ""}`,
    text: [heading, ...(kind === "announcement" ? [`Hi ${recipient.member?.name || "there"},`] : []), date,
      ...(safeEventPosterUrl(event.poster) ? [`Event poster: ${safeEventPosterUrl(event.poster)}`] : []),
      ...(kind === "announcement" ? [event.location, description, ...banners] : promoNotice ? [promoNotice] : []),
      priceText, `View event: ${detailsUrl}`, `Get your ticket: ${url}`,
      ...(!member ? [membership, `Become a member: ${memberSignupUrl}`] : [])].join("\n\n"),
  };
}
