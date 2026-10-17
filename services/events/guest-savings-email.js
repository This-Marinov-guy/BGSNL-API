import moment from "moment-timezone";
import { academicYearStart, ACADEMIC_YEAR_TIME_ZONE } from "../../util/config/academic-year.js";
import { formatEventEmailDate } from "./event-email-preview.js";

export const GUEST_SAVINGS_TEMPLATE = "e203c44d-d3a2-4661-8e40-e37698911c8b";
const escape = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const euro = cents => new Intl.NumberFormat("en-NL", { style: "currency", currency: "EUR" }).format(cents / 100);
const euroAfter = cents => `${euro(cents).replace("€", "").trim()}€`;
const eventDate = event => new Date(event.correctedDate || event.date);
const dateLabel = date => formatEventEmailDate({ date });
const regionLabel = region => String(region || "your region").replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
const safeHttpsUrl = value => {
  if (typeof value !== "string" || value.length > 2048) return "";
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : ""; }
  catch { return ""; }
};

export function availableEventPoster(event) {
  const poster = safeHttpsUrl(event.poster);
  if (!poster || event.mediaCleanupAt) return "";
  // Older archives removed their Cloudinary folder. Do not send a broken image.
  if (event.status === "archived" && event.archiveCleanupCompletedAt && !event.mediaRetainedAt && event.folder &&
    new URL(poster).hostname === "res.cloudinary.com") {
    let path = new URL(poster).pathname;
    try { path = decodeURIComponent(path); } catch { /* Use the encoded path. */ }
    if (path.includes(`/${String(event.folder).replace(/^\/+|\/+$/g, "")}/`)) return "";
  }
  return poster;
}

export function regionalPosterStart(now = new Date()) {
  const start = moment(academicYearStart(now)).tz(ACADEMIC_YEAR_TIME_ZONE).add(1, "day");
  if (start.isAfter(now)) start.subtract(1, "year");
  return start.toDate();
}

export function pastRegionalPosters(events, region, now = new Date()) {
  const start = regionalPosterStart(now);
  return events.flatMap(event => {
    const date = eventDate(event);
    const poster = availableEventPoster(event);
    if (event.region !== region || event.hidden || ["draft", "cancelled", "canceled"].includes(event.status) ||
      !Number.isFinite(date.getTime()) || date < start || date >= now || !poster) return [];
    return [{ title: String(event.title || "Event"), poster, date: dateLabel(date), timestamp: date.getTime(), id: String(event._id || event.id || "") }];
  }).sort((left, right) => right.timestamp - left.timestamp || left.id.localeCompare(right.id))
    .map(({ title, poster, date }) => ({ title, poster, date }));
}

export function buildGuestSavingsTemplateVariables({ name = "", totalCents = 0, eventSavings = [], posters = [], termEvents = [], region = "", signupUrl = "https://bulgariansociety.nl/signup", showPosters = true }) {
  const total = euro(totalCents);
  const subject = totalCents > 0 ? `Your potential ticket savings: ${total}` : "Make more of your next event with BGSNL membership";
  const shown = eventSavings.slice(0, 6);
  const rows = shown.map((item, index) => ({ title: String(item.title || "Event"), ticketLabel: item.tickets > 1 ? `${item.tickets} tickets` : "1 ticket",
    amount: euro(item.savingsCents), badgeAmount: euroAfter(item.savingsCents), date: String(item.date || ""), poster: safeHttpsUrl(item.poster),
    stackTop: index ? "-24px" : "0", stackIndent: `${Math.min(index, 3) * 24}px`, stackLevel: index + 1 }));
  const posterRows = [];
  if (showPosters) for (let index = 0; index < rows.length; index += 2) posterRows.push({ left: rows[index], right: rows[index + 1] || null });
  return { subject, name: name || "there", total, hasSavings: totalCents > 0,
    rows, posterRows,
    remainingCount: eventSavings.length - shown.length, posters, termEvents, regionLabel: regionLabel(region), signupUrl };
}

export function buildGuestSavingsEmail(input) {
  const { subject, name, total, hasSavings, rows, posterRows: shownPosters, remainingCount, signupUrl } = buildGuestSavingsTemplateVariables(input);
  const posterCard = item => `<td class="savings-grid-cell" width="50%" valign="top" align="center" style="width:50%;padding:0 6px 12px;text-align:center;"><div style="display:inline-block;position:relative;width:126px;max-width:100%;">${item.poster ? `<img class="savings-poster" src="${escape(item.poster)}" alt="${escape(item.title)} poster" width="126" style="display:block;width:100%;max-width:126px;height:auto;max-height:180px;object-fit:contain;margin:0 auto;border-radius:8px;">` : `<div style="color:#607168;font-size:13px;">${escape(item.title)} poster unavailable</div>`}<span style="display:inline-block;position:absolute;top:8px;right:0;background:#b42318;color:#fff;border-radius:999px;padding:5px 9px;font-size:13px;line-height:1.2;font-weight:bold;white-space:nowrap;">−${escape(item.badgeAmount)}</span></div></td>`;
  const posterRows = [];
  for (const { left, right } of shownPosters) posterRows.push(right
    ? `<tr>${posterCard(left)}${posterCard(right)}</tr>`
    : `<tr><td class="savings-grid-empty" width="25%"></td>${posterCard(left)}<td class="savings-grid-empty" width="25%"></td></tr>`);
  const tickets = rows.map(item => `<div class="savings-ticket-wrap" style="position:relative;z-index:${item.stackLevel};margin-top:${item.stackTop};padding-left:${item.stackIndent};"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#fff;border:1px solid #c9dbce;border-left:5px solid #017363;border-radius:10px;"><tr><td style="padding:12px 15px 36px;"><span style="display:block;color:#017363;font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">Your event ticket</span><strong style="display:block;color:#173f35;font-size:16px;line-height:1.3;margin-top:3px;">${escape(item.title)}</strong><span style="display:block;color:#526b5c;font-size:13px;margin-top:3px;">${escape([item.date, item.ticketLabel].filter(Boolean).join(" · "))}</span></td><td width="54" align="center" style="width:54px;border-left:1px dashed #c9dbce;color:#017363;font-size:22px;font-weight:bold;">✦</td></tr></table></div>`).join("");
  const savings = hasSavings ? `<div style="background:#add8e6;border-radius:12px;padding:20px;text-align:center;margin:0 0 24px;"><span style="display:block;font-size:13px;color:#173f35;">Your potential ticket savings</span><strong style="display:block;font-size:34px;line-height:1.2;color:#173f35;">${escape(total)}</strong></div>${posterRows.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;"><tbody>${posterRows.join("")}</tbody></table>` : ""}${remainingCount ? `<p style="font-size:13px;">Plus ${remainingCount} more events included in the total.</p>` : ""}<h2 style="font-size:19px;line-height:1.3;color:#173f35;margin:24px 0 10px;">The tickets you could have kept</h2><p style="margin:0 0 16px;">Member tickets stay in your account.</p>${tickets}` : "<p>Member prices could help you save on future event tickets.</p>";
  return { subject,
    html: `<p style="margin:0 0 16px;">Hi ${escape(name)},${hasSavings ? " with a membership you could have saved" : ""}</p>${savings}<p style="margin:20px 0 18px;">Member prices, exclusive events and a community across the Netherlands.</p><p align="center" style="text-align:center;"><a href="${escape(signupUrl)}" style="display:inline-block;box-sizing:border-box;min-height:44px;background:#017363;color:#fff;border-radius:8px;padding:14px 20px;font-weight:bold;text-decoration:none;text-align:center;">Become a member</a></p>`,
    text: [`Hi ${name},${hasSavings ? " with a membership you could have saved" : ""}`, hasSavings ? `Your potential ticket savings: ${total}` : "Member prices could help you save on future event tickets.",
      ...rows.map(item => `${item.title}${item.date ? ` (${item.date})` : ""}: you could have saved ${item.amount}`),
      ...(remainingCount ? [`Plus ${remainingCount} more events included in your total.`] : []),
      ...(rows.length ? ["The tickets you could have kept: member tickets stay in your account."] : []),
      "Member prices, exclusive events and a community across the Netherlands.",
      `Become a member: ${signupUrl}`].join("\n\n") };
}
