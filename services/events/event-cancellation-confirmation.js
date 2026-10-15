import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import EventCancellationCode from "../../models/EventCancellationCode.js";
import HttpError from "../../models/Http-error.js";
import { ADMIN, EVENT_CANCELLATION_CONFIRM_TEMPLATE, SUPER_ADMIN } from "../../util/config/defines.js";
import { queueDomakinTemplateEmail } from "../background-services/domakin-mailer.js";
import { loadRegionEmails } from "../region-contacts.js";
import { withBillingLease } from "../subscriptions/lease.js";
import { cancellationCounts } from "./event-cancellation.js";
import { formatEventEmailDate } from "./event-email-preview.js";

export const CANCELLATION_CODE_TTL_MS = 10 * 60 * 1000;
export const CANCELLATION_RESEND_MS = 60 * 1000;
export const DEV_CANCELLATION_EMAIL = "vladsialvmarinov3142@gmail.com";
const CODE_PATTERN = /^\d{8}$/;
const invalidCode = () => new HttpError("The code is incorrect, expired, or has been used. Check the email or request a new code.", 409);

const codeDigest = (eventId, generation, code, secret) => {
  if (!secret) throw new Error("Authentication secret is missing");
  return createHmac("sha256", secret).update(`event-cancellation:${eventId}:${generation}:${code}`).digest("hex");
};

const equalDigest = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
};

export const cancellationRecipient = (region, emails, env = process.env) =>
  env.APP_ENV === "dev" ? DEV_CANCELLATION_EMAIL : emails[region];

export const canCancelEventWithoutEmail = roles =>
  Array.isArray(roles) && roles.some(role => role === ADMIN || role === SUPER_ADMIN);

const maskedAddress = address => {
  const [local, domain] = address.split("@");
  return `${local.slice(0, 2)}${"•".repeat(Math.max(2, Math.min(6, local.length - 2)))}@${domain}`;
};

export function cancellationConfirmationVariables(event, code) {
  const counts = cancellationCounts(event);
  return {
    eventTitle: event.title || "Untitled event",
    eventDate: formatEventEmailDate(event),
    regionLabel: String(event.region || "").replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase()),
    code,
    ticketCount: counts.total,
    paidCount: counts.paid,
    freeCount: counts.free,
  };
}

export function createEventCancellationConfirmationService({
  records = EventCancellationCode,
  loadContacts = loadRegionEmails,
  send = queueDomakinTemplateEmail,
  lease = withBillingLease,
  now = () => new Date(),
  env = process.env,
  secret = env.JWT_STRING,
  createCode = () => String(randomInt(0, 100_000_000)).padStart(8, "0"),
} = {}) {
  const key = eventId => `event-cancellation-confirmation:${eventId}`;
  const active = record => record && record.expiresAt > now() && record.attemptsLeft > 0;
  const publicState = record => ({ expiresAt: record.expiresAt, sentTo: maskedAddress(record.recipient),
    canResendAt: new Date(record.requestedAt.getTime() + CANCELLATION_RESEND_MS) });

  async function pending(eventId) {
    const record = await records.findById(eventId);
    return active(record) ? publicState(record) : null;
  }

  async function recipient(event) {
    const emails = await loadContacts();
    if (!emails[event.region]) throw new HttpError("The regional confirmation email is not configured. Ask an administrator to update the region contact.", 503);
    return cancellationRecipient(event.region, emails, env);
  }

  async function request(event) {
    const eventId = String(event.id || event._id);
    return lease(key(eventId), async () => {
      const existing = await records.findById(eventId);
      if (existing?.requestedAt?.getTime() + CANCELLATION_RESEND_MS > now().getTime()) {
        if (active(existing)) return { ...publicState(existing), sent: false };
        throw new HttpError("Too many incorrect codes. Request a new email after one minute.", 429);
      }
      const confirmationEmail = await recipient(event);
      const code = createCode();
      if (!CODE_PATTERN.test(code)) throw new Error("Cancellation code generator returned an invalid code");
      const generation = randomUUID();
      const requestedAt = now();
      const record = { generation, codeHash: codeDigest(eventId, generation, code, secret),
        region: event.region, recipient: confirmationEmail, attemptsLeft: 5, requestedAt,
        expiresAt: new Date(requestedAt.getTime() + CANCELLATION_CODE_TTL_MS) };
      await records.findOneAndUpdate({ _id: eventId }, { $set: record }, { upsert: true, new: true });
      try {
        await send(EVENT_CANCELLATION_CONFIRM_TEMPLATE, confirmationEmail,
          cancellationConfirmationVariables(event, code), { operationId: generation });
      } catch {
        await records.deleteOne({ _id: eventId, generation });
        throw new HttpError("We could not send the confirmation email. The event has not been cancelled. Try again.", 503);
      }
      return { ...publicState(record), sent: true };
    });
  }

  async function confirm(event, code, cancel) {
    const eventId = String(event.id || event._id);
    if (!CODE_PATTERN.test(code)) throw invalidCode();
    return lease(key(eventId), async () => {
      const record = await records.findOneAndUpdate({ _id: eventId, region: event.region,
        expiresAt: { $gt: now() }, attemptsLeft: { $gt: 0 } },
      { $inc: { attemptsLeft: -1 } }, { new: true });
      if (!record) throw invalidCode();
      const expected = codeDigest(eventId, record.generation, code, secret);
      if (!equalDigest(expected, record.codeHash)) throw invalidCode();
      const emails = await loadContacts();
      if (!emails[event.region] || cancellationRecipient(event.region, emails, env) !== record.recipient) {
        await records.deleteOne({ _id: eventId, generation: record.generation });
        throw new HttpError("The regional email has changed. Request a new confirmation code.", 409);
      }
      const consumed = await records.findOneAndDelete({ _id: eventId, generation: record.generation,
        codeHash: record.codeHash, expiresAt: { $gt: now() } });
      if (!consumed) throw invalidCode();
      await cancel();
      return { confirmed: true };
    });
  }

  return { pending, recipient, request, confirm };
}

export const eventCancellationConfirmation = createEventCancellationConfirmationService();

export async function beginEventCancellation({ roles, event, cancel, confirmationService = eventCancellationConfirmation }) {
  if (canCancelEventWithoutEmail(roles)) {
    await cancel();
    return { confirmationRequired: false, cancellationQueued: true };
  }
  const confirmation = await confirmationService.request(event);
  return { confirmationRequired: true, confirmation };
}
