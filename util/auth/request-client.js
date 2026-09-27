import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export function trustedWebsiteRequest(req, secret = process.env.SSR_SERVER_KEY) {
  const supplied = req.headers?.["x-bgsnl-server-key"];
  if (typeof secret !== "string" || !secret || typeof supplied !== "string") return false;
  const expected = Buffer.from(secret), actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function requestClientAddress(req) {
  const forwarded = req.headers?.["x-bgsnl-client-ip"];
  if (req.headers?.["x-bgsnl-browser-proxy"] === "1" && typeof forwarded === "string" && isIP(forwarded) && trustedWebsiteRequest(req)) return forwarded;
  return req.ip || req.socket?.remoteAddress || "unknown";
}
