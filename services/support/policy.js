import { createHash, timingSafeEqual } from "node:crypto";
import HttpError from "../../models/Http-error.js";
import { BILLING_LOCKED_STATUSES, BILLING_LOCK_EXEMPT } from "../../util/config/defines.js";

export const SUPPORT_TYPES = ["problem", "recommendation"];
export const SUPPORT_STATUSES = ["open", "resolved", "rejected", "paused"];
export const normalizeSupportStatus = status => ({ in_progress: "open", waiting_for_you: "open", closed: "resolved", frozen: "paused" })[status] || status;
export const SUPPORT_ROLES = ["super_admin", "admin", "support"];
export const MAX_MESSAGES = 200;
export const GUEST_ACCESS_MS = 90 * 24 * 60 * 60 * 1000;
export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const isSupportStaff = (account) => {
  if (!SUPPORT_ROLES.some((role) => account?.roles?.includes(role))) return false;
  if (account.status === "active") return true;
  // A billing hold does not block admin/super admin from staffing support.
  return BILLING_LOCKED_STATUSES.includes(account.status) && BILLING_LOCK_EXEMPT.some((role) => account.roles?.includes(role));
};
export const accountIds = (account) => account ? [...new Set([String(account._id || account.id), ...(account.accountAliases || []).map(String)])] : [];

export function textValue(value, label, max, required = true) {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.length > max || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
  })) {
    throw new HttpError(`${label} is invalid or too long.`, 422);
  }
  const clean = value.trim();
  if (required && !clean) throw new HttpError(`${label} is required.`, 422);
  return clean;
}

export function supportAttachments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3) throw new HttpError("Attach up to 3 files.", 422);
  return value.map((attachment) => {
    if (!attachment || !["image", "file"].includes(attachment.type) || typeof attachment.url !== "string" || attachment.url.length > 2000) {
      throw new HttpError("The attached photo is invalid.", 422);
    }
    let url;
    try { url = new URL(attachment.url); }
    catch { throw new HttpError("The attached photo is invalid.", 422); }
    if (url.protocol !== "https:" || url.username || url.password || url.hostname !== "res.cloudinary.com" || !url.pathname.includes(attachment.type === "image" ? "/image/upload/" : "/raw/upload/") || (attachment.type === "file" && !/\.(pdf|txt)$/i.test(url.pathname))) {
      throw new HttpError("The attached photo is invalid.", 422);
    }
    return { type: attachment.type, url: url.toString(), ...(attachment.type === "file" ? { name: textValue(attachment.name, "File name", 200) } : {}) };
  });
}

export function uuid(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new HttpError("Invalid report or message reference.", 422);
  return value.toLowerCase();
}

export function guestHash(secret) {
  if (typeof secret !== "string" || !/^[0-9a-f]{64}$/i.test(secret)) throw new HttpError("This guest report requires its private browser access key.", 401);
  return digest(secret);
}

export function normalizeContact(input, account) {
  const values = account ? { name: [account.name, account.surname].filter(Boolean).join(" "), email: account.email, phone: account.phone || "" } : input;
  const name = textValue(values?.name, "Name", 160);
  const email = textValue(values?.email, "Email", 254, false).toLowerCase();
  const phone = textValue(values?.phone, "Phone", 40, false);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError("Enter a valid email address.", 422);
  if (phone && (!/^[+\d\s().-]+$/.test(phone) || phone.replace(/\D/g, "").length < 7 || phone.replace(/\D/g, "").length > 15)) throw new HttpError("Enter a valid phone number, including the country code.", 422);
  if (!email && !phone) throw new HttpError("Provide either an email address or a phone number.", 422);
  return { name, email, phone, source: account ? "account" : "guest" };
}

export function safePagePath(value) {
  const input = textValue(value, "Page path", 1000, false);
  if (!input) return "/";
  if (!input.startsWith("/") || input.startsWith("//") || /[\\\r\n]/.test(input)) throw new HttpError("Page path must be a local website path.", 422);
  const pathname = input.split(/[?#]/)[0].slice(0, 500);
  // Do not retain password-reset or sign-in tokens embedded in route segments.
  if (/password|reset|callback|oauth|verify/i.test(pathname)) return "/[account-access-page]";
  return pathname;
}

const metadataText = (value, max) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max)
  : "";
const dimension = (value) => Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 20000 ? Number(value) : undefined;
const decimal = (value, max) => Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= max ? Number(value) : undefined;

export function supportEnvironment(value, serverUserAgent = "") {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const viewport = input.viewport && typeof input.viewport === "object" ? input.viewport : {};
  const screen = input.screen && typeof input.screen === "object" ? input.screen : {};
  const environment = {
    userAgent: metadataText(serverUserAgent, 600),
    browser: metadataText(input.browser, 80),
    platform: metadataText(input.platform, 100),
    deviceType: metadataText(input.deviceType, 40),
    language: metadataText(input.language, 40),
    timezone: metadataText(input.timezone, 100),
    viewport: { width: dimension(viewport.width), height: dimension(viewport.height) },
    screen: { width: dimension(screen.width), height: dimension(screen.height) },
    devicePixelRatio: decimal(input.devicePixelRatio, 10),
    touchPoints: decimal(input.touchPoints, 100) || 0,
  };
  return Object.values(environment).some((entry) => typeof entry === "object" ? Object.values(entry).some(Boolean) : Boolean(entry)) ? environment : undefined;
}

export function authorizeConversation(conversation, { account, secret, staff = false }, now = Date.now()) {
  if (!conversation) throw new HttpError("Report not found or access has expired.", 404);
  let allowed = false;
  if (staff) allowed = isSupportStaff(account);
  else if (account) allowed = !!conversation.ownerAccountId && accountIds(account).includes(conversation.ownerAccountId);
  else if (!conversation.ownerAccountId && /^[0-9a-f]{64}$/i.test(secret || "") && new Date(conversation.guestAccessExpiresAt).getTime() > now) {
    const supplied = guestHash(secret);
    const expected = conversation.guestSecretHash || "";
    allowed = expected.length === supplied.length && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  }
  if (!allowed) throw new HttpError("Report not found or access has expired.", 404);
  return conversation;
}

export function validateStatus(status, current, staff) {
  if (status === "frozen") status = "paused";
  if (!SUPPORT_STATUSES.includes(status)) throw new HttpError("Unknown report status.", 422);
  if (!staff && (!["open", "resolved"].includes(status) || ["rejected", "paused"].includes(normalizeSupportStatus(current)))) throw new HttpError("Only support staff can make that status change.", 403);
  return status;
}

export function assertSupportReplyAllowed(record, { staff = false } = {}) {
  const status = normalizeSupportStatus(record.status);
  if (status === "rejected") throw new HttpError("This ticket is rejected. Start a new ticket if you still need help.", 409);
  if (!staff && status === "paused") throw new HttpError("This ticket is paused. Support must reopen it before you can reply.", 409);
  if (record.messageCount >= MAX_MESSAGES) throw new HttpError("This conversation has reached its message limit. Please start a new report.", 409);
}

export function pageNumber(value = "1") {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 200) throw new HttpError("Invalid report page.", 422);
  return Number(value);
}

export function publicConversation(record, { staff = false, before, limit = 50 } = {}) {
  const output = {
    id: record._id, reference: String(record._id).slice(0, 8).toUpperCase(), subject: record.subject,
    type: record.type || "problem", status: normalizeSupportStatus(record.status), createdAt: record.createdAt, updatedAt: record.updatedAt,
    lastMessageAt: record.lastMessageAt, lastAuthor: record.lastAuthor,
    messageCount: record.messageCount, revision: record.revision, pagePath: record.pagePath,
    ...(staff ? { contact: record.contact, ownerAccountId: record.ownerAccountId || null, environment: record.environment } : {}),
  };
  if (record.messages) {
    // Compute before pagination so an older support reply still counts.
    output.hasSupportReply = record.messages.some((message) => message.author === "staff" && message.kind !== "status");
    const pageSize = Number(limit);
    if (!Number.isInteger(pageSize) || pageSize < 10 || pageSize > 50) throw new HttpError("Invalid message page size.", 422);
    const end = before === undefined ? record.messages.length : Math.min(Number(before), record.messages.length);
    if (!Number.isSafeInteger(end) || end < 1) throw new HttpError("Invalid message page.", 422);
    // Filter on the server, including automatic screenshots stored before the
    // diagnostic flag existed. Manual uploads and captures remain client-visible.
    const visible = record.messages.map((message, order) => ({ ...message, order })).filter(message =>
      staff || !(message.diagnostic || (message.author === "requester" && message.text === "Automatic page screenshot" && message.attachments?.length > 0)));
    const page = visible.filter(message => message.order < end).slice(-pageSize);
    output.messages = page.map(({ id, text, attachments, author, kind, createdAt, order }) => ({
      id, text, attachments: attachments || [], author, kind, createdAt, order,
    }));
    output.before = visible.some(message => message.order < page[0]?.order) ? page[0].order : null;
    output.guestAccessExpiresAt = record.ownerAccountId ? null : record.guestAccessExpiresAt;
  }
  return output;
}
