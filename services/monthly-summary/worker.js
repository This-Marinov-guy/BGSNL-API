import { isEmailSchedulerProcess } from "../background-services/email-run-guard.js";
import { areInternalNotificationsEnabled, getInternalNotificationConfig } from "../../util/config/internal-notifications.js";
import { deliverInternalNotificationEmail } from "../background-services/email-transporter.js";
import { runObservedJob } from "../monitoring/job-history.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { monthKey, nextMonthlySummaryTime, summaryIsDue } from "./policy.js";
import { claimMonthlyDelivery, finishMonthlyDelivery, freezeMonthlySnapshot, loadMonthlyRecipients, loadMonthlySnapshot } from "./data.js";
import { buildMonthlySummaryEmail } from "./email.js";

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
  loadRecipients = loadMonthlyRecipients, freeze = freezeMonthlySnapshot,
  claim = claimMonthlyDelivery, finish = finishMonthlyDelivery, send = deliverInternalNotificationEmail,
} = {}) {
  if (!config.enabled) return { status: "disabled", sent: 0 };
  if (!summaryIsDue(now)) return { status: "not-due", sent: 0 };
  const month = monthKey(now);
  const [draft, recipients] = await Promise.all([
    loadSnapshot(month, { now }), loadRecipients({ now, internalEmails: config.internalEmails }),
  ]);
  const snapshot = await freeze(month, draft, { now });
  const notification = buildMonthlySummaryEmail(snapshot);
  let sent = 0, skipped = 0, failed = 0;
  for (const email of recipients.emails) {
    // Claim before delivery: provider timeouts or process restarts cannot cause
    // automatic duplicate sends. Uncertain deliveries need manual inspection.
    const id = await claim(month, email, { now });
    if (!id) { skipped++; continue; }
    try {
      await send({ receiver: email, ...notification });
      await finish(id, "sent");
      sent++;
    } catch (error) {
      failed++;
      logOperationalError("monthly-summary.delivery", error);
      await finish(id, "uncertain");
    }
  }
  return { status: failed ? "delivery-failed" : "processed", month, sent, skipped, failed };
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
