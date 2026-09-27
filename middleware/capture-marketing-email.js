import { enqueueMarketingCapture } from "../services/jobs/marketing-capture-queue.js";
import { logOperationalError } from "./axiom-logger.js";

const SUCCESS_MIN = 200;
const SUCCESS_MAX = 300;
const FORM_METHODS = new Set(["POST", "PUT", "PATCH"]);
const EMAIL_FIELDS = ["email", "guestEmail"];
const CITY_FIELDS = ["city", "region"];
const MARKETING_CONSENT_VERSION = "2026-09-10";

const hasMarketingConsent = (body) =>
  body?.notificationTerms === true || body?.notificationTerms === "true" ||
  body?.marketingConsent === true || body?.marketingConsent === "true" ||
  body?.consent === true || body?.consent === "true";

const firstStringField = (body, fields) => {
  for (const field of fields) {
    if (typeof body?.[field] === "string" && body[field].trim()) {
      return body[field];
    }
  }

  return null;
};

export const extractMarketingEmail = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  // A successful contact, checkout or account request is not consent to
  // promotional mail. Only an explicit, separately submitted opt-in is eligible.
  if (!hasMarketingConsent(body)) return null;

  const email = firstStringField(body, EMAIL_FIELDS);
  const city = firstStringField(body, CITY_FIELDS);

  return email && city ? {
    email,
    city,
    consent: {
      granted: true,
      recordedAt: new Date(),
      textVersion: String(body.marketingConsentVersion || MARKETING_CONSENT_VERSION),
    },
  } : null;
};

export const queueMarketingEmail = (entry, requestLabel = "unknown", enqueue = enqueueMarketingCapture) => {
  if (!entry) return undefined;
  // The form response is already finished. Once Redis accepts the job, retries
  // survive API restarts. An enqueue outage must not invalidate the form itself.
  return Promise.resolve().then(() => enqueue(entry, requestLabel)).catch((error) => {
    logOperationalError("service.marketing-capture-enqueue", error);
  });
};

const captureMarketingEmail = (req, res, next) => {
  if (!FORM_METHODS.has(req.method)) {
    return next();
  }

  res.once("finish", () => {
    if (res.locals.skipMarketingCapture) return;
    if (res.statusCode < SUCCESS_MIN || res.statusCode >= SUCCESS_MAX) return;

    // Multipart parsers run inside individual routes, so read req.body only
    // after the response has finished rather than when this middleware starts.
    const entry = extractMarketingEmail(req.body);
    queueMarketingEmail(entry, `${req.method} ${req.originalUrl}`);
  });

  return next();
};

export default captureMarketingEmail;
