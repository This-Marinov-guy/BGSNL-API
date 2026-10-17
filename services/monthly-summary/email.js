import { formatEventEmailDate } from "../events/event-email-preview.js";
import { safeHttpsUrl } from "./policy.js";

const escape = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const dateLabel = date => formatEventEmailDate({ date });
const linkStyle = "color:#017363;text-decoration:underline;font-weight:bold;";
const iconBaseUrl = "https://res.cloudinary.com/dqwcx5zyh/image/upload/emails/bgsnl";
const growthMetric = (count, label, icon) => `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td width="44" valign="top" style="width:44px;padding:0 12px 0 0;"><img src="${iconBaseUrl}-${icon}-20261011.png" width="32" height="32" alt="" style="display:block;width:32px;height:32px;"></td><td valign="top" style="font-size:14px;line-height:1.35;color:#173f35;"><strong style="display:block;font-size:22px;line-height:1.2;">${escape(count)}</strong>${label}</td></tr></table>`;
const posterGrid = events => {
  const cells = events.map(event => {
    const url = safeHttpsUrl(event.url);
    const poster = safeHttpsUrl(event.poster);
    const content = poster ? `<img src="${escape(poster)}" width="220" alt="${escape(event.title)}" style="display:block;width:100%;max-width:220px;height:auto;max-height:280px;object-fit:contain;margin:0 auto;border-radius:8px;">` : `<span style="display:block;padding:24px 12px;border:1px solid #cbd8d0;border-radius:8px;color:#607168;font-size:13px;">Poster unavailable for ${escape(event.title)}</span>`;
    return `<td width="50%" align="center" valign="top" style="width:50%;padding:0 8px 16px;vertical-align:top;text-align:center;">${url ? `<a href="${escape(url)}" style="display:block;text-decoration:none;">${content}</a>` : content}</td>`;
  });
  const rows = [];
  for (let i = 0; i < cells.length; i += 2) rows.push(`<tr>${cells[i]}${cells[i + 1] || '<td width="50%" style="width:50%;"></td>'}</tr>`);
  return `<table class="monthly-poster-grid" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;table-layout:fixed;margin:16px -8px 0;">${rows.join("")}</table>`;
};
const articleRow = article => {
  const url = safeHttpsUrl(article.url);
  if (!url) return "";
  const image = safeHttpsUrl(article.image);
  const thumbnail = image
    ? `<img src="${escape(image)}" width="112" height="112" alt="" style="display:block;width:112px;height:112px;object-fit:cover;border-radius:8px;">`
    : `<table role="presentation" width="112" height="112" cellspacing="0" cellpadding="0" border="0" bgcolor="#e3eee5" style="width:112px;height:112px;background:#e3eee5;border-radius:8px;"><tr><td align="center" valign="middle" style="color:#173f35;font-size:12px;font-weight:700;text-align:center;">BGSNL</td></tr></table>`;
  return `<table class="monthly-article-row" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:0 0 16px;border-collapse:collapse;"><tr><td width="112" valign="top" style="width:112px;padding:0 16px 0 0;vertical-align:top;">${thumbnail}</td><td valign="middle" style="padding:0;vertical-align:middle;"><strong style="display:block;margin:0 0 10px;color:#173f35;font-size:17px;line-height:1.3;">${escape(article.title)}</strong><a href="${escape(url)}" style="display:inline-block;box-sizing:border-box;min-height:44px;padding:11px 16px;border-radius:8px;background:#173f35;color:#ffffff;font-size:14px;line-height:22px;font-weight:700;text-decoration:none;text-align:center;">Read more</a></td></tr></table>`;
};

export function buildMonthlySummaryEmail({ month, label, members, alumni, ticketsSold = 0, events = [], articles = [], news = [] }) {
  const title = `${label}: what your support made possible`;
  const thanks = "Thank you for supporting Bulgarian Society Netherlands. Your support helps us bring our community together. Here is what we shared this month.";
  const growth = [
    ...(members > 0 ? [growthMetric(members, "new members", "monthly-member")] : []),
    ...(alumni > 0 ? [growthMetric(alumni, "new alumni", "monthly-alumni")] : []),
  ];
  const growthHtml = growth.length ? `<h2 style="font-size:24px;margin:32px 0 12px;">Our community grew</h2><table class="monthly-growth" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:0 0 24px;"><tr>${growth.map(metric => `<td width="${growth.length === 1 ? "100" : "50"}%" valign="top" style="width:${growth.length === 1 ? "100" : "50"}%;padding:0 8px 0 0;">${metric}</td>`).join("")}</tr></table>` : "";
  const articleRows = articles.map(articleRow).filter(Boolean);
  const articlesHtml = articleRows.length ? `<h2 style="font-size:24px;margin:32px 0 12px;">Articles of the month</h2>${articleRows.join("")}` : "";
  const newsHtml = news.length ? `<h2 style="font-size:24px;margin:32px 0 12px;">Community updates</h2>${news.map(item => `<h3 style="font-size:18px;margin:24px 0 8px;">${escape(item.title)}</h3><p style="margin:0;line-height:1.6;">${escape(item.body).replaceAll("\n", "<br>")}</p>${safeHttpsUrl(item.url) ? `<p><a style="${linkStyle}" href="${escape(safeHttpsUrl(item.url))}">Read more: ${escape(item.title)}</a></p>` : ""}`).join("")}` : "";
  const htmlBody = `<h1 style="font-size:28px;line-height:1.25;margin:0 0 24px;">${escape(title)}</h1><p>${thanks}</p>${growthHtml}<h2 style="font-size:24px;margin:32px 0 12px;">Events this month</h2>${events.length ? `${growthMetric(ticketsSold, "total tickets sold", "monthly-ticket")}${posterGrid(events)}` : "<p>No events took place this month. Thank you for continuing to support our community.</p>"}${articlesHtml}${newsHtml}<p style="margin-top:32px;"><strong>Thank you for being part of our alumni community.</strong></p>`;
  return {
    type: "monthly-supporter-summary", entityId: month, category: "monthly-supporter-summary",
    subject: title,
    text: [title, thanks, ...(growth.length ? ["Our community grew", ...(members > 0 ? [`${members} new members`] : []), ...(alumni > 0 ? [`${alumni} new alumni`] : [])] : []), "Events this month", ...(events.length ? [`Total tickets sold: ${ticketsSold}`] : []),
      ...(events.length ? events.map(event => `${event.title} — ${dateLabel(event.date)}${event.url ? `\n${event.url}` : ""}`) : ["No events took place this month. Thank you for continuing to support our community."]),
      ...(articles.length ? ["Articles of the month", ...articles.map(item => `${item.title}${item.description ? `\n${item.description}` : ""}${item.url ? `\n${item.url}` : ""}`)] : []),
      ...(news.length ? ["Community updates", ...news.map(item => `${item.title}\n${item.body}${item.url ? `\n${item.url}` : ""}`)] : []),
      "Thank you for being part of our alumni community.",
    ].join("\n\n"),
    htmlBody,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title></head><body style="margin:0;background:#f0f5f1;color:#19251f;font-family:Arial,sans-serif;font-size:16px;line-height:1.6;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px;"><table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#fff;border-radius:12px;"><tr><td style="padding:32px 24px;">${htmlBody}<p style="color:#607168;">The sent campaign includes a personal unsubscribe link.</p></td></tr></table></td></tr></table></body></html>`,
  };
}
