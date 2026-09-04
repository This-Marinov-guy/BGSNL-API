import MarketingEmail from "../models/MarketingEmail.js";

const SUCCESS_MIN = 200;
const SUCCESS_MAX = 300;
const FORM_METHODS = new Set(["POST", "PUT", "PATCH"]);
const EMAIL_FIELDS = ["email", "guestEmail"];
const CITY_FIELDS = ["city", "region"];

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

  const email = firstStringField(body, EMAIL_FIELDS);
  const city = firstStringField(body, CITY_FIELDS);

  return email && city ? { email, city } : null;
};

export const queueMarketingEmail = (entry, requestLabel = "unknown") => {
  if (!entry) return;

  setImmediate(async () => {
    try {
      await MarketingEmail.add(entry);
    } catch (error) {
      // Marketing capture must never fail or delay the submitted form.
      console.error(
        `[marketing-email] Background capture failed for ${requestLabel}:`,
        error
      );
    }
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
