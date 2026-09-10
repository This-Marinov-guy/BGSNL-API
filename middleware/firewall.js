import crypto from "crypto";
import HttpError from "../models/Http-error.js";
import { allowedOrigins, ssrServerKey } from "../util/config/access.js";
import { requestClientAddress, trustedWebsiteRequest } from "../util/auth/request-client.js";
import AuthRateLimit from "../models/AuthRateLimit.js";
import { isConfiguredServiceRequest } from "./pass-secure.js";

/** True only for the SSR server presenting its server-only shared key. */
export const isTrustedServerRequest = (req) =>
  !!ssrServerKey && trustedWebsiteRequest(req, ssrServerKey);

const requestKey = (value) => crypto.createHash("sha256").update(value).digest("hex");
// Keep distinct endpoint families separate without letting a caller create an
// unlimited number of rate-limit buckets by cycling Mongo IDs or opaque tokens.
const rateLimitPath = (path) => String(path || "/")
  .replace(/\/[a-f\d]{24}(?=\/|$)/gi, "/:id")
  .replace(/\/[A-Za-z0-9_-]{32,}(?=\/|$)/g, "/:token");
const browserOrigin = (value) => {
  if (typeof value !== "string" || !value) return null;
  try { return new URL(value).origin; } catch { return null; }
};

/** A Mongo-backed limiter shared by API instances, including read requests. */
export const rateLimiter = async (req, res, next) => {
  if (isTrustedServerRequest(req)) return next();

  const windowMs = 15 * 60 * 1000;
  const now = Date.now();
  const bucket = Math.floor(now / windowMs);
  const read = ["GET", "HEAD", "OPTIONS"].includes(req.method);
  const maximum = read ? 300 : 100;
  const id = `api:${read ? "read" : "write"}:${requestKey(`${requestClientAddress(req)}:${req.method}:${rateLimitPath(req.path)}`)}:${bucket}`;

  try {
    let record;
    try {
      record = await AuthRateLimit.findOneAndUpdate(
        { _id: id },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 2) * windowMs) } },
        { upsert: true, new: true }
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      record = await AuthRateLimit.findOneAndUpdate({ _id: id }, { $inc: { count: 1 } }, { new: true });
    }
    if (!record || record.count > maximum) {
      res.set("Retry-After", String(Math.ceil(((bucket + 1) * windowMs - now) / 1000)));
      return next(new HttpError("Rate limit exceeded. Try again later!", 429));
    }
  } catch {
    return next(new HttpError("Request protection is temporarily unavailable.", 503));
  }

  return next();
};

export const firewall = (req, res, next) => {
  if (isTrustedServerRequest(req) || isConfiguredServiceRequest(req)) return next();

  // Origin is CORS admission, never identity. Sensitive routes also verify a
  // JWT, Stripe signature or scoped service credential at their own boundary.
  const origin = browserOrigin(req.headers.origin) || browserOrigin(req.headers.referer);
  if (!origin || !allowedOrigins.includes(origin)) {
    return next(new HttpError("Forbidden: Access is denied!", 403));
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Support-Token");
  return next();
};
