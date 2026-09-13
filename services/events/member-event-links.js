import { createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import HttpError from "../../models/Http-error.js";
import { ACCESS_4, HOME_URL } from "../../util/config/defines.js";
import { checkDiscountsOnEvents } from "../main-services/event-action-service.js";

const invalid = () => new HttpError("This ticket link is invalid or has expired. Please open the event on the website.", 410);
const emailHash = (email) => createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex");
const TOKEN_CONTEXT = Buffer.from("bgsnl:member-event-ticket:e1");
const encryptionKey = (env) => {
  const key = env.EVENT_TICKET_LINK_SECRET || env.JWT_STRING;
  if (!key || key.length < 32) throw new Error("Event ticket links require EVENT_TICKET_LINK_SECRET or JWT_STRING (at least 32 characters)");
  return hkdfSync("sha256", Buffer.from(key), Buffer.from("bgsnl:event-ticket"), TOKEN_CONTEXT, 32);
};

export const eventPageUrl = (event) => `${HOME_URL}/${encodeURIComponent(event.region)}/event-details/${encodeURIComponent(event.slug || event.id || event._id)}`;
export const eventPurchaseUrl = (event) => `${HOME_URL}/${encodeURIComponent(event.region)}/purchase-ticket/${encodeURIComponent(event.id || event._id)}`;

export function createMemberEventLink(event, member, { env = process.env } = {}) {
  const expiresAt = Math.min(new Date(event.correctedDate || event.date).getTime(), new Date(event.ticketTimer).getTime());
  if (!Number.isFinite(expiresAt)) throw new Error("Event ticket deadline is missing");
  const eventId = String(event.id || event._id);
  const memberId = String(member.id || member._id);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(env), iv, { authTagLength: 16 });
  cipher.setAAD(TOKEN_CONTEXT);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ eventId, memberId, email: emailHash(member.email), exp: expiresAt }), "utf8"),
    cipher.final(),
  ]);
  const token = `e1.${Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64url")}`;
  const base = (env.EVENT_ANNOUNCEMENT_API_URL || "https://kanatitsa.bulgariansociety.nl/api/v1").replace(/\/+$/, "");
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
    throw new Error("Invalid EVENT_ANNOUNCEMENT_API_URL");
  }
  return `${base}/payment/event-ticket?token=${token}`;
}

export function verifyMemberEventLink({ token }, { env = process.env, now = Date.now() } = {}) {
  if (typeof token !== "string" || token.length > 1500) throw invalid();
  const match = token.match(/^e1\.([A-Za-z0-9_-]+)$/);
  if (!match) throw invalid();
  const packed = Buffer.from(match[1], "base64url");
  if (packed.length <= 28 || packed.toString("base64url") !== match[1]) throw invalid();
  const key = encryptionKey(env);
  let claims;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12), { authTagLength: 16 });
    decipher.setAAD(TOKEN_CONTEXT);
    decipher.setAuthTag(packed.subarray(-16));
    // Never parse or use plaintext until final() authenticates the whole token.
    const plaintext = Buffer.concat([decipher.update(packed.subarray(12, -16)), decipher.final()]);
    claims = JSON.parse(plaintext.toString("utf8"));
  } catch { throw invalid(); }
  if (!claims || typeof claims.eventId !== "string" || typeof claims.memberId !== "string" || typeof claims.email !== "string" || !/^[a-f\d]{24}$/i.test(claims.eventId || "") || !/^(?:member_)?[a-f\d]{24}$/i.test(claims.memberId || "") || !Number.isSafeInteger(claims.exp) || claims.exp <= now || !/^[a-f\d]{64}$/.test(claims.email || "")) throw invalid();
  return claims;
}

export const linkMatchesMember = (claims, member) => claims.email === emailHash(member.email);
export const isCurrentEventMember = (member, now = Date.now()) => member?.status === "active" && new Date(member.expireDate).getTime() > now && !member.roles?.includes("alumni");
export const isPublicUpcomingEvent = (event, now = Date.now()) => event && !event.hidden && !["draft", "archived"].includes(event.status) && new Date(event.correctedDate || event.date).getTime() > now;
export const isEventOnSale = (event, now = Date.now()) => isPublicUpcomingEvent(event, now) && !event.isSaleClosed && new Date(event.ticketTimer).getTime() > now && Number(event.ticketLimit) > (event.guestList?.length || 0);
export const requiresEventChoices = (event) => Boolean(event.extraInputsForm?.length || (event.addOns?.isEnabled && event.addOns?.isMandatory));

export function memberEventPrice(event, member) {
  if (event.isFree || event.isMemberFree) return { price: 0 };
  const plain = typeof event.toObject === "function" ? event.toObject() : structuredClone(event);
  const { product } = checkDiscountsOnEvents(plain);
  return member.roles?.some((role) => ACCESS_4.includes(role)) && product?.activeMember?.priceId ? product.activeMember : product?.member;
}

// Email navigation has no website Origin. Admit only this exact GET/HEAD
// route after authenticating its encrypted token; the handler still checks the DB.
export function isVerifiedMemberEventNavigation(req, options) {
  if (!["GET", "HEAD"].includes(req.method)) return false;
  if (!/^\/api\/v1\/payment\/event-ticket\/?$/.test(String(req.path || ""))) return false;
  try {
    verifyMemberEventLink({ token: req.query?.token }, options);
    return true;
  } catch { return false; }
}
