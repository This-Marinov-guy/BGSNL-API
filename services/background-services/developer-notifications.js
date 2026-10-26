import { getDeveloperNotificationConfig } from "../../util/config/internal-notifications.js";
import { deliverInternalNotificationEmail, sendInternalNotificationEmail } from "./email-transporter.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";

const WINDOW_MS = 15 * 60 * 1000;
const safeLabel = (value, pattern, fallback) => typeof value === "string" && pattern.test(value) ? value : fallback;

export function buildWebhookErrorNotification(details, env = process.env) {
  // Intentionally exclude exception messages, stacks, body, headers and query strings.
  const environment = ["dev", "prod", "test"].includes(env.APP_ENV) ? env.APP_ENV : "unknown";
  const provider = details.provider === "stripe" ? "stripe" : "webhook";
  const status = Number.isInteger(details.status) && details.status >= 400 && details.status <= 599 ? details.status : 500;
  const eventId = safeLabel(details.eventId, /^evt_[a-zA-Z0-9]{1,100}$/, "unverified-or-unavailable");
  const eventType = safeLabel(details.eventType, /^[a-z][a-z_.]{0,100}$/, "unverified-or-unavailable");
  const mode = typeof details.livemode === "boolean" ? (details.livemode ? "live" : "test") : "unverified";
  const subject = `[BGSNL ${environment}] ${provider} webhook error — HTTP ${status}`;
  const text = [subject, `Environment: ${environment}`, `Provider: ${provider}`, `HTTP status: ${status}`,
    `Stripe mode: ${mode}`, `Verified event ID: ${eventId}`, `Verified event type: ${eventType}`,
    `Detected: ${new Date().toISOString()}`,
    status >= 500 ? "Processing failed. Inspect server logs and Stripe delivery attempts; the original error response was preserved."
      : "Request rejected. Check endpoint configuration and signing secret in secure settings; this may also be invalid traffic.",
    "Payloads, credentials and exception messages are intentionally omitted.",
    "Repeated alerts are limited for 15 minutes per event/status; at most 20 alerts per 15 minutes per server process.",
  ].join("\n");
  return { subject, text, type: "developer-webhook-error", entityId: `${provider}:${status}:${eventId}` };
}

export function createDeveloperNotifier({ config = getDeveloperNotificationConfig(), sendEmail = sendInternalNotificationEmail,
  env = process.env, now = Date.now } = {}) {
  const recent = new Map();
  let windowStart = now(), count = 0;
  return async (details) => {
    if (!config.enabled || !config.subscribers.length) return 0;
    const timestamp = now();
    for (const [key, expires] of recent) if (expires <= timestamp) recent.delete(key);
    if (timestamp - windowStart >= WINDOW_MS) { windowStart = timestamp; count = 0; }
    const notification = buildWebhookErrorNotification(details, env);
    if (recent.has(notification.entityId) || count >= 20) return 0;
    recent.set(notification.entityId, timestamp + WINDOW_MS);
    count++;
    let queued = 0;
    for (const receiver of config.subscribers) {
      try { await sendEmail({ ...notification, receiver }); queued++; }
      catch (error) { logOperationalError("service.webhook-alert", error); console.error("Developer webhook alert could not be queued."); }
    }
    if (!queued) { recent.delete(notification.entityId); count--; }
    return queued;
  };
}

export const notifyWebhookError = createDeveloperNotifier();

export async function sendDeveloperJobAlert({ source, name, attempts, stoppedAt }, {
  config = getDeveloperNotificationConfig(), sendEmail = deliverInternalNotificationEmail,
  env = process.env } = {}) {
  if (!config.enabled || !config.subscribers.length) return 0;
  const environment = ["dev", "prod", "test"].includes(env.APP_ENV) ? env.APP_ENV : "unknown";
  const safeSource = safeLabel(source, /^[a-z][a-z0-9-]{0,49}$/, "unknown");
  const safeName = safeLabel(name, /^[a-z][a-z0-9-]{0,49}$/, "unknown");
  const schedulerHalted = safeSource === "scheduler";
  const subject = `[BGSNL ${environment}] Background job ${schedulerHalted ? "stopped" : "failed"}: ${safeName}`;
  const text = [subject, `Job: ${safeSource}/${safeName}`, `Failed attempts: ${Number.isSafeInteger(attempts) ? attempts : 5}`,
    `${schedulerHalted ? "Stopped" : "Failed"} at: ${new Date(stoppedAt).toISOString()}`,
    schedulerHalted
      ? "The job is paused after repeated failures. Inspect job monitoring and server logs, fix the cause, then reset its job failure state."
      : "The job exhausted its attempts. Inspect job monitoring and server logs, fix the cause, then requeue if needed.",
    "No job payloads, exception messages, credentials or recipient data are included."].join("\n");
  let sent = 0;
  for (const receiver of config.subscribers) {
    try { await sendEmail({ receiver, subject, text, type: "developer-job-failure", entityId: `${safeSource}:${safeName}` }); sent++; }
    catch (error) { logOperationalError("service.job-failure-alert", error); }
  }
  return sent;
}

export async function sendDeveloperMemberRevenueAlert(issue, {
  config = getDeveloperNotificationConfig(), sendEmail = deliverInternalNotificationEmail,
  env = process.env } = {}) {
  if (!config.enabled || !config.subscribers.length) return 0;
  const environment = ["dev", "prod", "test"].includes(env.APP_ENV) ? env.APP_ENV : "unknown";
  const kind = safeLabel(issue?.kind, /^(insufficient-balance|capture|settlement|allocation|review)$/, "settlement");
  const invoiceId = safeLabel(issue?.invoiceId, /^in_[a-zA-Z0-9]{1,100}$/, "unavailable");
  const subscriptionId = safeLabel(issue?.subscriptionId, /^sub_[a-zA-Z0-9]{1,100}$/, "unavailable");
  const accountId = safeLabel(issue?.accountId, /^acct_[a-zA-Z0-9]{1,100}$/, "unavailable");
  const amount = Number.isSafeInteger(issue?.amount) && issue.amount > 0 ? issue.amount : null;
  const subject = `[BGSNL ${environment}] Member revenue transfer needs attention: ${kind}`;
  const text = [subject, `Reason: ${kind}`, `Invoice: ${invoiceId}`, `Subscription: ${subscriptionId}`,
    `Connected account: ${accountId}`, ...(amount === null ? [] : [`Amount: EUR ${(amount / 100).toFixed(2)}`]),
    `Detected: ${new Date().toISOString()}`,
    "Inspect the paid invoice, its pending revenue operation, the connected account and Stripe balance. The worker will retry on the next balance event or scheduled sweep.",
    "No payment payloads, exception messages, credentials or recipient data are included."].join("\n");
  let sent = 0;
  for (const receiver of config.subscribers) {
    try { await sendEmail({ receiver, subject, text, type: "developer-member-revenue", entityId: `${kind}:${invoiceId}:${accountId}` }); sent++; }
    catch (error) { logOperationalError("service.member-revenue-alert", error); }
  }
  return sent;
}
