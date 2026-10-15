import { createHash } from "node:crypto";
import { isEmailSchedulerProcess } from "../background-services/email-run-guard.js";
import { areInternalNotificationsEnabled, getInternalNotificationConfig } from "../../util/config/internal-notifications.js";
import { queueDomakinTemplateEmail } from "../background-services/domakin-mailer.js";
import { runObservedJob } from "../monitoring/job-history.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { monthKey, nextMonthlySummaryTime, summaryIsDue } from "./policy.js";
import { loadMonthlyRecipients, loadMonthlySnapshot } from "./data.js";
import { buildMonthlySummaryEmail } from "./email.js";

export const MONTHLY_SUPPORTER_SUMMARY_TEMPLATE = "a6c04115-7cd6-4f82-871e-bb2b7bbf6459";
const uuidFor = value => {
  const digest = createHash("sha256").update(value).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

export const monthlySummaryConfig = (env = process.env) => {
  const internal = getInternalNotificationConfig(env);
  return {
    enabled: isEmailSchedulerProcess(env) && (env.MONTHLY_SUPPORTER_SUMMARY_ENABLED === undefined
      ? env.NODE_ENV === "production" : areInternalNotificationsEnabled(env.MONTHLY_SUPPORTER_SUMMARY_ENABLED)),
    internalEmails: internal.enabled ? internal.subscribers : [],
  };
};

export async function processMonthlySummary({
  now = new Date(), config = monthlySummaryConfig(), loadSnapshot = loadMonthlySnapshot,
  loadRecipients = loadMonthlyRecipients, send = queueDomakinTemplateEmail,
} = {}) {
  if (!config.enabled) return { status: "disabled", sent: 0 };
  if (!summaryIsDue(now)) return { status: "not-due", sent: 0 };
  const month = monthKey(now);
  const [snapshot, recipients] = await Promise.all([
    loadSnapshot(month, { now }), loadRecipients({ now, internalEmails: config.internalEmails }),
  ]);
  const notification = buildMonthlySummaryEmail(snapshot);
  const batchId = uuidFor(`monthly-supporter-summary:${month}`);
  let sent = 0, failed = 0;
  for (const email of recipients.emails) {
    const operationId = uuidFor(`monthly-supporter-summary:${month}:${email}`);
    try {
      await send(MONTHLY_SUPPORTER_SUMMARY_TEMPLATE, email,
        { subject: notification.subject, html: notification.htmlBody, text: notification.text },
        { operationId, bulk: { batchId, batchType: "monthly_supporter_summary",
          totalRecipients: recipients.emails.length, source: "bgsnl-monthly-summary", sourceId: month,
          audience: "alumni_supporters" } });
      sent++;
    } catch (error) {
      failed++;
      logOperationalError("monthly-summary.delivery", error);
    }
  }
  return { status: failed ? "delivery-failed" : "processed", month, sent, failed };
}

export function startMonthlySummaryWorker({
  config = monthlySummaryConfig(), processSummary = processMonthlySummary,
  now = () => new Date(), schedule = setTimeout, cancel = clearTimeout, observe = runObservedJob,
} = {}) {
  if (!config.enabled) return async () => {};
  let stopped = false, timer, running;
  let dueAt = nextMonthlySummaryTime(now());
  const arm = () => {
    if (stopped) return;
    // A month exceeds Node's maximum setTimeout delay. Wake at most daily to
    // re-arm the timer, without sending or querying recipients on those wakes.
    timer = schedule(tick, Math.max(1, Math.min(86400000, +dueAt - +now())));
    timer.unref?.();
  };
  const tick = () => {
    if (stopped || running) return;
    const current = now();
    if (+current < +dueAt) { arm(); return; }
    running = Promise.resolve().then(() => observe("scheduler", "monthly-supporter-summary", () => processSummary({ config, now: current })))
      .catch(error => logOperationalError("worker.monthly-supporter-summary", error))
      .finally(() => { running = null; dueAt = nextMonthlySummaryTime(now()); arm(); });
  };
  arm();
  return async () => { stopped = true; cancel(timer); await running; };
}
