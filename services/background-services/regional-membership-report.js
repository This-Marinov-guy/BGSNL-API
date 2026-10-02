import moment from "moment-timezone";
import { REGIONS } from "../../util/config/defines.js";
import { loadRegionEmails } from "../region-contacts.js";
import { createEmailRunGuard } from "./email-run-guard.js";
import { deliverInternalNotificationEmail } from "./email-transporter.js";
import { logIntegrationError } from "../../middleware/axiom-logger.js";
import {
  buildWeeklyMembershipSummaryNotification, getCompletedMembershipWeek,
  getWeeklyMembershipReportConfig, loadWeeklyMembershipSummary, startWeeklyMembershipReportWorker,
} from "./weekly-membership-report.js";

const reportRuns = createEmailRunGuard();

export async function processRegionalMembershipReports({
  now = new Date(), config = getWeeklyMembershipReportConfig(),
  loadContacts = loadRegionEmails, loadSummary = loadWeeklyMembershipSummary,
  runGuard = reportRuns, send = deliverInternalNotificationEmail,
} = {}) {
  if (!config.enabled) return { status: "disabled", sent: 0 };
  const current = moment(now).tz(config.timeZone);
  if (current.isoWeekday() !== 7 || current.hour() !== 18 || current.minute() !== 0) {
    return { status: "not-due", sent: 0 };
  }
  const period = getCompletedMembershipWeek(now, config.timeZone);
  const [emails, summary] = await Promise.all([loadContacts(), loadSummary(period)]);
  let sent = 0, skipped = 0, failed = 0, missingContacts = 0;
  for (const row of summary.rows) {
    // National/support contacts are directory entries, not local chapters.
    // An alumni-only week does not trigger a regional new-member report.
    if (!REGIONS.includes(row.region) || row.members <= 0) continue;
    const receiver = emails[row.region];
    if (!receiver) { missingContacts++; continue; }
    if (!runGuard.claim(period.key, row.region)) { skipped++; continue; }
    const { members, alumni, total } = row;
    try {
      await send({ receiver, ...buildWeeklyMembershipSummaryNotification({
        ...period, rows: [row], totals: { members, alumni, total },
        totalLabel: "Region total", region: row.region,
      }) });
      sent++;
    } catch (error) {
      // A timeout may follow acceptance by the provider. Do not resend blindly.
      failed++;
      logIntegrationError("mailer", error, "regional-membership-report");
    }
  }
  return { status: failed || missingContacts ? "delivery-failed" : "processed",
    reportKey: period.key, sent, skipped, failed, missingContacts };
}

export const startRegionalMembershipReportWorker = (options = {}) =>
  startWeeklyMembershipReportWorker({ ...options,
    processReport: options.processReport || processRegionalMembershipReports,
    jobName: "regional-membership-report",
  });
