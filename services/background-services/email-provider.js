import "dotenv/config";
import { MailtrapClient } from "mailtrap";
import { queueDomakinTemplateEmail } from "./domakin-mailer.js";
import { observeIntegrationRequest } from "../../middleware/axiom-logger.js";

export const DOMAKIN_NOTIFICATION_TEMPLATE = "ccbe1725-0b2c-47a7-b34e-a4f11336c56b";
export const DOMAKIN_CAMPAIGN_TEMPLATES = new Set([
  "a6c04115-7cd6-4f82-871e-bb2b7bbf6459", // Monthly supporter summary
  "e203c44d-d3a2-4661-8e40-e37698911c8b", // Guest ticket savings
  "59f51c9c-88e0-49bc-9e62-b14c8aa4a71d", // Regional event campaign
  "9c0b5ec5-6038-4980-9dd1-db9db8f377bb", // BWY 9.11.2025
  "7e8088d0-3408-4875-ae5d-21a810fe0c7d", // Deloitte
  "2b7d818d-d669-4fd2-af97-f05e3f1c2a8e", // Gala 2026 BG
  "0682331e-9e97-47e9-849f-daafb2f47aee", // Gala 2026 EN
  "54a938b1-7423-45d0-b37b-c77aceab4210", // Official mock
  "5947c9b6-795a-4bb7-aa23-916b317a8156", // PWC
  "2cf8d31e-8239-4d5f-9ed3-8288a49b74b8", // Member event announcement
]);

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
    if (!useDomakinMailer(env) && !DOMAKIN_CAMPAIGN_TEMPLATES.has(String(message.template_uuid || "").toLowerCase())) {
      const send = legacySend || ((payload) => new MailtrapClient({ endpoint: env.MAIL_ENDPOINT, token: env.MAIL_TOKEN }).send(payload));
      // The operation ID belongs to Domakin Mailer, not the legacy provider.
      const payload = message.operationId ? { ...message } : message;
      if (message.operationId) delete payload.operationId;
      return observeIntegrationRequest("mailtrap", "send-email", "POST", () => send(payload));
    }
    if (!Array.isArray(message.to) || message.to.length !== 1 || message.cc || message.bcc || message.attachments) {
      throw new Error("Domakin delivery requires one recipient and no caller-supplied CC/BCC/attachments.");
    }
    if (message.template_uuid) {
      return message.operationId
        ? queueTemplate(message.template_uuid, message.to[0], message.template_variables || {}, { operationId: message.operationId })
        : queueTemplate(message.template_uuid, message.to[0], message.template_variables || {});
    }
    if (!message.subject || (!message.text && !message.html)) throw new Error("Email subject and content are required.");
    const variables = {
      subject: message.subject,
      html: message.html || `<pre>${escapeHtml(message.text)}</pre>`,
      text: message.text || "",
    };
    return message.operationId
      ? queueTemplate(DOMAKIN_NOTIFICATION_TEMPLATE, message.to[0], variables, { operationId: message.operationId })
      : queueTemplate(DOMAKIN_NOTIFICATION_TEMPLATE, message.to[0], variables);
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
