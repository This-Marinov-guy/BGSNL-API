import { BADGE_FONT_FACE_CSS, formatRegionBadgeLabel, getRegionBadgeTheme } from "../../util/config/region-badges.js";

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
export const eventEmailPreviewMobileCss = `@media screen and (max-width:620px){.bgsnl-event-preview{background:transparent!important;border-radius:0!important;overflow:visible!important}.bgsnl-event-card-content{background:transparent!important}.bgsnl-event-details{padding:12px!important;height:190px!important}.bgsnl-event-title{font-size:16px!important;line-height:20px!important;max-height:60px!important;overflow:hidden!important;display:-webkit-box!important;-webkit-line-clamp:3!important}.bgsnl-event-poster{width:32%!important;max-width:160px!important;height:190px!important;background:none!important;border-radius:12px!important;overflow:hidden!important}.bgsnl-event-poster img{width:100%!important;max-width:148px!important;height:auto!important;max-height:178px!important;object-fit:contain!important;border-radius:8px!important}.bgsnl-poster-placeholder{width:100%!important;height:190px!important;border-radius:12px!important}}`;

export function renderEventEmailPreview({ title, date, poster, region }) {
  const safePoster = safeEventPosterUrl(poster);
  const badgeTheme = region ? getRegionBadgeTheme(region) : null;
  const regionBadge = badgeTheme
    ? `<span style="display:inline-block;margin:0 0 10px;padding:3px 7px;border:0;border-radius:7px;background:${badgeTheme.background};color:${badgeTheme.color};font-family:'LeagueSpartan',Arial,sans-serif;font-size:12px;line-height:1.2;font-weight:600;">${escapeHtml(formatRegionBadgeLabel(region))}</span>`
    : "";
  const posterCell = safePoster
    ? `<td class="bgsnl-event-poster" width="32%" height="220" align="center" valign="middle" style="width:32%;max-width:160px;height:220px;padding:6px;vertical-align:middle;text-align:center;"><img src="${escapeHtml(safePoster)}" width="148" alt="${escapeHtml(title)} poster" style="display:block;width:100%;max-width:148px;height:auto;max-height:208px;object-fit:contain;object-position:center;margin:0 auto;border-radius:8px;"></td>`
    : "";
  return `<style>${BADGE_FONT_FACE_CSS}</style><table class="bgsnl-event-preview" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${panelBackground}" style="width:100%;border-collapse:separate;border-spacing:0;margin:0 0 24px;background:${panelBackground};border-radius:12px;overflow:hidden;"><tr><td class="bgsnl-event-card-content" bgcolor="${panelBackground}" style="padding:0;background:${panelBackground};"><table class="bgsnl-event-layout" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;table-layout:fixed;"><tr><td class="bgsnl-event-details" align="center" valign="middle" height="220" style="height:220px;padding:16px;vertical-align:middle;text-align:center;">${regionBadge}<strong class="bgsnl-event-title" style="display:block;color:#173f35;font-size:19px;line-height:1.3;font-weight:700;">${escapeHtml(title)}</strong>${date ? `<span style="display:block;margin-top:8px;color:#40584b;font-size:15px;line-height:1.4;">${escapeHtml(date)}</span>` : ""}</td>${posterCell}</tr></table></td></tr></table>`;
}
