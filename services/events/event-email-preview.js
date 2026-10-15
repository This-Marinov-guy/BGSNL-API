import { formatRegionBadgeLabel, getRegionBadgeTheme } from "../../util/config/region-badges.js";

const escapeHtml = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export const safeEventPosterUrl = value => {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
};

export const formatEventEmailDate = event => {
  const date = new Date(event.correctedDate || event.date);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.day}.${parts.month} | ${parts.hour}:${parts.minute}`;
};

const panelBackground = "#add8e6";
export const eventEmailPreviewMobileCss = `@media screen and (max-width:620px){.bgsnl-event-preview{background:transparent!important;border-radius:0!important;overflow:visible!important}.bgsnl-event-card-content{background:transparent!important}.bgsnl-event-details{padding:12px!important;height:190px!important}.bgsnl-event-title{font-size:16px!important;line-height:20px!important;max-height:60px!important;overflow:hidden!important;display:-webkit-box!important;-webkit-box-orient:vertical!important;-webkit-line-clamp:3!important}.bgsnl-event-poster{width:40%!important;height:190px!important;background:none!important;border-radius:12px!important;overflow:hidden!important}.bgsnl-event-poster img,.bgsnl-poster-placeholder{width:100%!important;height:190px!important;border-radius:12px!important}}`;

export function renderEventEmailPreview({ title, date, poster, region }) {
  const safePoster = safeEventPosterUrl(poster);
  const badgeTheme = region ? getRegionBadgeTheme(region) : null;
  const regionBadge = badgeTheme
    ? `<span style="display:inline-block;margin:0 0 10px;padding:5px 10px;border:1px solid ${badgeTheme.border};border-radius:999px;background:${badgeTheme.background};color:${badgeTheme.color};font-size:12px;line-height:1.3;font-weight:700;">${escapeHtml(formatRegionBadgeLabel(region))}</span>`
    : "";
  const posterCell = safePoster
    ? `<td class="bgsnl-event-poster" width="40%" height="220" valign="top" background="${escapeHtml(safePoster)}" style="width:40%;height:220px;padding:0;vertical-align:top;background-image:url(&quot;${escapeHtml(safePoster)}&quot;);background-position:center;background-size:cover;"><img src="${escapeHtml(safePoster)}" width="210" height="220" alt="${escapeHtml(title)} poster" style="display:block;width:100%;height:220px;object-fit:cover;object-position:center;border-radius:0 12px 12px 0;"></td>`
    : "";
  return `<table class="bgsnl-event-preview" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${panelBackground}" style="width:100%;border-collapse:separate;border-spacing:0;margin:0 0 24px;background:${panelBackground};border-radius:12px;overflow:hidden;"><tr><td class="bgsnl-event-card-content" bgcolor="${panelBackground}" style="padding:0;background:${panelBackground};"><table class="bgsnl-event-layout" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;table-layout:fixed;"><tr><td class="bgsnl-event-details" align="center" valign="middle" height="220" style="height:220px;padding:16px;vertical-align:middle;text-align:center;">${regionBadge}<strong class="bgsnl-event-title" style="display:block;color:#173f35;font-size:19px;line-height:1.3;font-weight:700;">${escapeHtml(title)}</strong>${date ? `<span style="display:block;margin-top:8px;color:#40584b;font-size:15px;line-height:1.4;">${escapeHtml(date)}</span>` : ""}</td>${posterCell}</tr></table></td></tr></table>`;
}
