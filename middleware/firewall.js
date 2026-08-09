import crypto from "crypto";
import HttpError from "../models/Http-error.js";
import { allowedIps, allowedOrigins, ssrServerKey } from "../util/config/access.js";
import { requestCache } from "../util/config/caches.js";
import { isAllowedCrawlerBot } from "../util/functions/helpers.js";

const timingSafeEqual = (a, b) => {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");

  // timingSafeEqual throws on length mismatch, so compare lengths first. The
  // length of a rejected key is not worth hiding; its contents are.
  if (left.length === 0 || left.length !== right.length) return false;

  return crypto.timingSafeEqual(left, right);
};

/**
 * True when the caller presents the shared secret the Next.js server uses for
 * SSR data fetching. Browsers cannot send this header cross-origin because it
 * is not listed in Access-Control-Allow-Headers.
 */
export const isTrustedServerRequest = (req) =>
  !!ssrServerKey && timingSafeEqual(req.headers["x-bgsnl-server-key"], ssrServerKey);

export const rateLimiter = (req, res, next) => {
  if (req.method === "GET") return next();

  const ip =
    req.ip ||
    req.headers["x-forwarded-for"] ||
    req.connection.remoteAddress ||
    "unknown";
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - 3600; // 1 hour ago
  const maxRequests = 100;

  let entry = requestCache.get(ip);
  if (!entry) {
    requestCache.set(ip, [now]);
    return next();
  }

  entry = entry.filter((timestamp) => timestamp > windowStart);

  if (entry.length >= maxRequests) {
    console.error(`Rate limit exceeded for IP: ${ip}`);
    return next(new HttpError("Rate limit exceeded. Try again later!", 429));
  }

  entry.push(now);
  requestCache.set(ip, entry);
  return next();
};

export const firewall = async (req, res, next) => {
  const origin = req.headers.origin || req.headers.referer || "unknown origin";
  const connectingIp =
    req.headers["do-connecting-ip"] ??
    req.ip ??
    req.headers["x-forwarded-for"] ??
    req.connection.remoteAddress ??
    "unknown IP";
  const userAgent = req.headers["user-agent"] ?? "";

  // TODO: optimize for crawler check
  //   if (await isAllowedCrawlerBot(connectingIp, userAgent)) {
  //     console.log(`Googlebot allowed: IP ${connectingIp}`);
  //     return next();
  //   }

  // Server-rendered pages fetch their data from the Next.js server, which has
  // no browser Origin. Checked first, and intentionally without setting any
  // Access-Control-* headers: this is not a browser request.
  if (isTrustedServerRequest(req)) {
    return next();
  }

  if (allowedOrigins.includes(origin) || allowedIps.includes(connectingIp)) {
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,DELETE,OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
    return next();
  } else {
    console.log(origin, connectingIp, userAgent);
    return next(new HttpError("Forbidden: Access is denied!", 403));
  }
};
