import { HOME_URL } from "../../util/config/defines.js";
import { safeHttpsUrl, SUMMARY_TIME_ZONE } from "./policy.js";

const escape = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const dateLabel = date => new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: SUMMARY_TIME_ZONE }).format(new Date(date));
const linkStyle = "color:#017363;text-decoration:underline;font-weight:bold;";

export function buildMonthlySummaryEmail({ month, label, members, alumni, events, news, cutoff }) {
  const title = `${label}: what your support made possible`;
  const thanks = "Thank you for supporting Bulgarian Society Netherlands. Your support helps us bring our community together. Here is what we shared this month.";
  const eventRows = events.map(event => {
    const poster = safeHttpsUrl(event.poster);
    const url = safeHttpsUrl(event.url);
    const name = escape(event.title);
    return `<tr><td style="padding:12px 0;vertical-align:top;width:112px;">${poster ? `<img src="${escape(poster)}" alt="${name}" width="96" style="display:block;width:96px;max-width:100%;height:auto;border-radius:8px;">` : '<span style="color:#607168;">No poster</span>'}</td><td style="padding:12px 0;vertical-align:middle;"><h3 style="margin:0 0 8px;font-size:18px;line-height:1.4;">${url ? `<a href="${escape(url)}" style="${linkStyle}">${name}</a>` : name}</h3><p style="margin:0;color:#607168;">${escape(dateLabel(event.date))}</p></td></tr>`;
  }).join("");
  const newsHtml = news.length ? `<h2 style="font-size:24px;margin:32px 0 12px;">Society news</h2>${news.map(item => `<h3 style="font-size:18px;margin:24px 0 8px;">${escape(item.title)}</h3><p style="margin:0;line-height:1.6;">${escape(item.body).replaceAll("\n", "<br>")}</p>${safeHttpsUrl(item.url) ? `<p><a style="${linkStyle}" href="${escape(safeHttpsUrl(item.url))}">Read more: ${escape(item.title)}</a></p>` : ""}`).join("")}` : "";
  return {
    type: "monthly-supporter-summary", entityId: month, category: "monthly-supporter-summary",
    subject: title,
    text: [title, thanks, `Welcome to ${members} new members and ${alumni} new alumni!`, "Events this month",
      ...(events.length ? events.map(event => `${event.title} — ${dateLabel(event.date)}${event.url ? `\n${event.url}` : ""}`) : ["No events took place this month. Thank you for continuing to support our community."]),
      ...(news.length ? ["Society news", ...news.map(item => `${item.title}\n${item.body}${item.url ? `\n${item.url}` : ""}`)] : []),
      "Thank you for being part of our alumni community.",
      `Figures as of ${new Date(cutoff).toISOString()} (${SUMMARY_TIME_ZONE}).`,
      `You receive this update as an active alumni supporter with email updates enabled, or as an internal notification subscriber. Contact us to change your email preferences: ${HOME_URL}/contact`,
    ].join("\n\n"),
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title></head><body style="margin:0;background:#f0f5f1;color:#19251f;font-family:Arial,sans-serif;font-size:16px;line-height:1.6;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px;"><table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#fff;border-radius:12px;"><tr><td style="padding:32px 24px;"><h1 style="font-size:28px;line-height:1.25;margin:0 0 24px;">${escape(title)}</h1><p>${thanks}</p><h2 style="font-size:24px;margin:32px 0 12px;">Our community grew</h2><p><strong>${members}</strong> new members and <strong>${alumni}</strong> new alumni joined the society.</p><h2 style="font-size:24px;margin:32px 0 12px;">Events this month</h2>${events.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${eventRows}</table>` : "<p>No events took place this month. Thank you for continuing to support our community.</p>"}${newsHtml}<p style="margin-top:32px;"><strong>Thank you for being part of our alumni community.</strong></p><p style="color:#607168;">Figures as of ${escape(new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: SUMMARY_TIME_ZONE }).format(new Date(cutoff)))} (${SUMMARY_TIME_ZONE}).</p><p style="color:#607168;">You receive this update as an active alumni supporter with email updates enabled, or as an internal notification subscriber. <a href="${escape(`${HOME_URL}/contact`)}" style="${linkStyle}">Contact us to change your email preferences</a>.</p></td></tr></table></td></tr></table></body></html>`,
  };
}
