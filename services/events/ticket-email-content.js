const escape = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const safeUrl = value => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : ""; }
  catch { return ""; }
};
const autoDownloadWalletUrl = value => {
  const safe = safeUrl(value);
  if (!safe) return "";
  const url = new URL(safe);
  if (url.pathname !== "/wallet/ticket") return safe;
  url.searchParams.set("autoDownloadPass", "true");
  return url.href;
};
const appleBadge = "https://res.cloudinary.com/dqwcx5zyh/image/upload/v1792221931/emails/add-to-apple-wallet-570x180_tig4rn.png";

export function buildTicketEmailContent({ eventName, eventDate, guestName, ticketUrl, poster, walletUrl, signupUrl }) {
  const name = escape(eventName), date = escape(eventDate), guest = escape(guestName);
  const ticket = safeUrl(ticketUrl), image = safeUrl(poster), wallet = autoDownloadWalletUrl(walletUrl), signup = safeUrl(signupUrl);
  const action = (href, label) => `<a href="${escape(href)}" style="display:block;box-sizing:border-box;width:190px;height:60px;line-height:60px;border-radius:8px;background:#173f35;color:#ffffff;text-align:center;font:700 16px/60px Arial,sans-serif;text-decoration:none;">${label}</a>`;
  const posterHtml = image ? `<td width="32%" align="center" valign="middle" style="width:32%;max-width:160px;padding:12px 12px 12px 0;vertical-align:middle;text-align:center;"><img src="${escape(image)}" alt="${name} poster" width="148" style="display:block;width:100%;max-width:148px;height:auto;max-height:208px;object-fit:contain;margin:0 auto;border-radius:8px;"></td>` : "";
  const ticketImageHtml = ticket ? `<tr><td style="padding:0 24px 20px;"><img src="${escape(ticket)}" alt="Ticket for ${name}" width="500" style="display:block;width:100%;max-width:500px;height:auto;object-fit:contain;"></td></tr>` : "";
  const walletHtml = ticket && wallet ? `<td class="wallet-action-cell" valign="middle" style="padding:0 0 0 8px;"><a href="${escape(wallet)}" aria-label="Add ticket to Wallet" style="display:block;width:190px;height:60px;"><img src="${appleBadge}" alt="Add to Apple Wallet" width="190" height="60" style="display:block;width:190px;height:60px;border:0;"></a></td>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>@media screen and (max-width:480px){.wallet-action-cell{display:block!important;padding:12px 0 0!important}}</style></head><body style="margin:0;background:#f0f5f1;color:#19251f;font:16px/1.5 Arial,sans-serif;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f0f5f1;"><tr><td align="center" style="padding:24px 12px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:12px;"><tr><td style="padding:28px 24px 12px;"><p style="margin:0 0 8px;color:#017363;font-size:14px;font-weight:700;">Bulgarian Society Netherlands</p><h1 style="margin:0;color:#173f35;font-size:26px;line-height:1.2;">Your ticket for ${name}</h1><p style="margin:16px 0 0;">Hi ${guest}, your ticket is ready. We look forward to seeing you.</p></td></tr><tr><td style="padding:8px 24px 20px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="table-layout:fixed;background:#edf3ee;border-radius:10px;"><tr><td valign="middle" style="padding:16px;vertical-align:middle;"><strong style="display:block;color:#173f35;font-size:18px;line-height:1.25;">${name}</strong><span style="display:block;margin-top:8px;">${date}</span></td>${posterHtml}</tr></table></td></tr>${ticketImageHtml}<tr><td style="padding:0 24px 24px;"><p style="margin:0 0 14px;">Keep your ticket ready at the entrance.</p><table role="presentation" cellspacing="0" cellpadding="0"><tr><td valign="middle" style="padding:0 8px 0 0;">${ticket ? action(ticket, "View ticket") : ""}</td>${walletHtml}</tr></table>${ticket ? `<p style="margin:18px 0 0;color:#607168;font-size:13px;">If the button does not open, <a href="${escape(ticket)}" style="color:#017363;">view your ticket here</a>.</p>` : ""}${signup ? `<p style="margin:18px 0 0;">Enjoyed the event? <a href="${escape(signup)}" style="color:#017363;">Join the society</a> for member benefits.</p><p style="margin:16px 0 0;padding:14px;border-radius:8px;background:#fff3d6;color:#352718;">Guest tickets expire one day after the event. Keep future tickets in your account by becoming a member.</p>` : ""}</td></tr></table></td></tr></table></body></html>`;
  const text = `Your ticket for ${eventName}\n${eventDate}\n\nHi ${guestName}, your ticket is ready.\n\nView ticket: ${ticketUrl}${ticket && wallet ? `\nAdd to Wallet: ${wallet}` : ""}${signup ? `\nJoin the society: ${signup}` : ""}`;
  return { subject: `Your ticket for ${eventName}`, html, text };
}
