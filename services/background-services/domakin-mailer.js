import { randomUUID } from "node:crypto";
import axios from "axios";

export const DOMAKIN_MAILER_CHANNEL = "bulgariansociety";
export const DOMAKIN_MAILER_FROM_ADDRESS = "info@bulgariansociety.nl";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requiredString = (value, field) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
};

const templateEndpoint = (baseUrl) => {
  const normalized = requiredString(baseUrl, "MAILER_API_URL").replace(/\/+$/, "");
  const parsed = new URL(normalized);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("MAILER_API_URL must use http or https.");
  }
  return `${normalized.endsWith("/api") ? normalized : `${normalized}/api`}/delivery/template`;
};

const normalizeReceiver = (receiver) => {
  const value = typeof receiver === "string" ? { email: receiver } : receiver;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("receiver must be an email address or receiver object.");
  }

  const email = requiredString(value.email, "receiver.email").toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new Error("receiver.email is invalid.");

  const id = value.id === undefined || value.id === null ? "" : String(value.id);
  return { email, id };
};

const normalizeVariables = (variables) => {
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    throw new Error("templateVariables must be an object.");
  }
  return variables;
};

export const createDomakinMailerClient = ({
  baseUrl = process.env.MAILER_API_URL,
  secret = process.env.MAILER_BULGARIANSOCIETY_SECRET,
  httpClient = axios,
  timeoutMs = 95_000,
} = {}) => ({
  async queueTemplateEmail(
    templateId,
    receiver,
    templateVariables = {},
    { operationId = randomUUID() } = {}
  ) {
    const normalizedTemplateId = requiredString(templateId, "templateId");
    const normalizedSecret = requiredString(
      secret,
      "MAILER_BULGARIANSOCIETY_SECRET"
    );
    if (normalizedSecret.length < 32) {
      throw new Error("MAILER_BULGARIANSOCIETY_SECRET must contain at least 32 characters.");
    }
    if (!UUID_PATTERN.test(operationId)) {
      throw new Error("operationId must be a UUID.");
    }

    const response = await httpClient.post(
      templateEndpoint(baseUrl),
      {
        templateId: normalizedTemplateId,
        receiver: normalizeReceiver(receiver),
        variables: normalizeVariables(templateVariables),
        // The caller cannot select a sender. Domakin Mailer resolves this
        // channel to its locked info@bulgariansociety.nl identity.
        channel: DOMAKIN_MAILER_CHANNEL,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Domakin-Caller": "bgsnl_api",
          "X-Domakin-Operation-Id": operationId,
          "X-Mailer-Wait-For-Acceptance": "true",
          "X-Mailer-Admin-Secret": normalizedSecret,
        },
        timeout: timeoutMs,
      }
    );

    return response.data;
  },
});

/**
 * Additive Domakin Mailer entry point. Existing Mailtrap and Resend helpers
 * remain unchanged and continue to handle every current BGSNL email flow.
 */
export const queueDomakinTemplateEmail = (
  templateId,
  receiver,
  templateVariables = {},
  options = {}
) =>
  createDomakinMailerClient().queueTemplateEmail(
    templateId,
    receiver,
    templateVariables,
    options
  );
