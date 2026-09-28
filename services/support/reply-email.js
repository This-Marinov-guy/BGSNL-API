import { HOME_URL } from "../../util/config/defines.js";

const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export function buildCustomerSupportReplyEmail(ticket, reply) {
  const url = new URL(HOME_URL);
  url.searchParams.set("supportTicket", ticket.id);
  const reference = ticket.reference || String(ticket.id).slice(0, 8).toUpperCase();
  const subject = `Support replied to ticket #${reference}`;
  const guidance = ticket.ownerAccountId
    ? "Sign in to the account you used to create this ticket."
    : "For your privacy, open this link in the same browser you used to create this ticket.";
  // Keep conversation contents and attachment URLs out of email. The website
  // still checks account ownership or the guest's locally saved access key.
  return {
    receiver: ticket.contact.email,
    subject,
    type: "support-customer-replied",
    entityId: `${ticket.id}:${reply.id}`,
    text: `${subject}\n\nOur support team has replied to your ticket.\n\nOpen ticket: ${url.href}\n\n${guidance}`,
    html: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
      <body style="margin:0;padding:24px 12px;background:#bcd2bf;font-family:Arial,sans-serif;color:#173f35;">
        <table role="presentation" style="width:100%;max-width:600px;margin:auto;background:#fff;border-radius:16px;"><tr><td style="padding:32px;">
          <h1 style="font-size:24px;line-height:1.3;margin:0 0 20px;">${escapeHtml(subject)}</h1>
          <p style="font-size:16px;line-height:1.6;">Our support team has replied to your ticket.</p>
          <p style="margin:28px 0;"><a href="${escapeHtml(url.href)}" style="display:inline-block;padding:14px 24px;border-radius:8px;background:#017363;color:#fff;font-size:16px;font-weight:bold;text-decoration:none;">Open ticket</a></p>
          <p style="font-size:16px;line-height:1.6;">${escapeHtml(guidance)}</p>
          <p style="font-size:16px;line-height:1.6;">Bulgarian Society Netherlands Support</p>
        </td></tr></table>
      </body></html>`,
  };
}
