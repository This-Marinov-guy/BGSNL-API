import "dotenv/config";
import { MailtrapClient } from "mailtrap";
import { queueDomakinTemplateEmail } from "./domakin-mailer.js";

export const DOMAKIN_NOTIFICATION_TEMPLATE = "ccbe1725-0b2c-47a7-b34e-a4f11336c56b";

export function useDomakinMailer(env = process.env) {
  const provider = env.BGSNL_EMAIL_PROVIDER?.trim().toLowerCase() || "legacy";
  if (!["legacy", "domakin"].includes(provider)) throw new Error("BGSNL_EMAIL_PROVIDER must be legacy or domakin.");
  return provider === "domakin";
}

const escapeHtml = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Preserve the existing Mailtrap message contract, but opt in to one local
 * delivery path. Never fall back to an external provider after a local failure:
 * an ambiguous response could otherwise cause two emails to be sent. */
export function createEmailSender({ env = process.env, queueTemplate = queueDomakinTemplateEmail, legacySend } = {}) {
  return async (message) => {
    if (!useDomakinMailer(env)) {
      const send = legacySend || ((payload) => new MailtrapClient({ endpoint: env.MAIL_ENDPOINT, token: env.MAIL_TOKEN }).send(payload));
      return send(message);
    }
    if (!Array.isArray(message.to) || message.to.length !== 1 || message.cc || message.bcc || message.attachments) {
      throw new Error("Domakin delivery requires one recipient and no caller-supplied CC/BCC/attachments.");
    }
    if (message.template_uuid) {
      return queueTemplate(message.template_uuid, message.to[0], message.template_variables || {});
    }
    if (!message.subject || (!message.text && !message.html)) throw new Error("Email subject and content are required.");
    return queueTemplate(DOMAKIN_NOTIFICATION_TEMPLATE, message.to[0], {
      subject: message.subject,
      html: message.html || `<pre>${escapeHtml(message.text)}</pre>`,
      text: message.text || "",
    });
  };
}

export const sendEmail = createEmailSender();

export function resolveDomakinResendTemplate(templateId, env = process.env) {
  // A Resend slug is not a Mailer UUID. Require an explicit mapping rather than
  // guessing which campaign or language is equivalent.
  let aliases;
  try { aliases = JSON.parse(env.DOMAKIN_RESEND_TEMPLATE_MAP || "{}"); }
  catch { throw new Error("DOMAKIN_RESEND_TEMPLATE_MAP must be a JSON object of Resend IDs to Mailer UUIDs."); }
  const mapped = aliases && typeof aliases === "object" && !Array.isArray(aliases) && Object.hasOwn(aliases, templateId) ? aliases[templateId] : null;
  if (typeof mapped !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mapped)) {
    throw new Error("This Resend template needs a DOMAKIN_RESEND_TEMPLATE_MAP entry and matching Mailer snapshot before local delivery.");
  }
  return mapped;
}
