import moment from "moment-timezone";
import MemberUser from "../../models/MemberUser.js";
import AlumniUser from "../../models/AlumniUser.js";
import { createEmailRunGuard, isEmailSchedulerProcess } from "./email-run-guard.js";
const reportRuns = createEmailRunGuard();
import { REGIONS } from "../../util/config/defines.js";
import {
  areInternalNotificationsEnabled,
  getInternalNotificationConfig,
} from "../../util/config/internal-notifications.js";
import { CURRENT_ACCOUNT_FILTER } from "../../util/subscriptions/policy.js";
import { deliverInternalNotificationEmail } from "./email-transporter.js";
import { logIntegrationError, logOperationalError } from "../../middleware/axiom-logger.js";
import { runObservedJob } from "../monitoring/job-history.js";

export const WEEKLY_MEMBERSHIP_REPORT_TIME_ZONE = "Europe/Amsterdam";
const REPORT_TYPE = "weekly-membership-summary";

const REGION_LABELS = Object.freeze({
  amsterdam: "Amsterdam",
  breda_tilburg: "Breda–Tilburg",
  eindhoven: "Eindhoven",
  groningen: "Groningen",
  leeuwarden: "Leeuwarden",
  maastricht: "Maastricht",
  rotterdam: "Rotterdam",
  leiden_hague: "Leiden–The Hague",
  netherlands: "Netherlands",
  unassigned: "Unassigned",
});

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const normalizeRegion = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized || "unassigned";
};

const regionLabel = (region) => REGION_LABELS[region] || region
  .split("_")
  .filter(Boolean)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(" ");

export const getWeeklyMembershipReportConfig = (env = process.env) => {
  const notifications = getInternalNotificationConfig(env);
  const explicitlyConfigured = env.WEEKLY_MEMBERSHIP_REPORT_ENABLED !== undefined;
  const reportEnabled = explicitlyConfigured
    ? areInternalNotificationsEnabled(env.WEEKLY_MEMBERSHIP_REPORT_ENABLED)
    : env.NODE_ENV === "production";
  return {
    enabled: isEmailSchedulerProcess(env) && notifications.enabled && reportEnabled,
    subscribers: notifications.subscribers,
    timeZone: WEEKLY_MEMBERSHIP_REPORT_TIME_ZONE,
  };
};

export const getNextMembershipReportTime = (now = new Date(), timeZone = WEEKLY_MEMBERSHIP_REPORT_TIME_ZONE) => {
  const current = moment(now).tz(timeZone);
  const next = current.clone().startOf("isoWeek").isoWeekday(7).hour(18);
  if (!next.isAfter(current)) next.add(1, "week");
  return next.toDate();
};

// Consecutive Sunday 18:00 cutoffs include every registration, including Sunday
// evening, without overlap. Calendar weeks respect Amsterdam daylight saving.
export const getCompletedMembershipWeek = (
  now = new Date(),
  timeZone = WEEKLY_MEMBERSHIP_REPORT_TIME_ZONE
) => {
  const current = moment(now).tz(timeZone);
  const periodEnd = current.clone().startOf("isoWeek").isoWeekday(7).hour(18);
  if (periodEnd.isAfter(current)) periodEnd.subtract(1, "week");
  const periodStart = periodEnd.clone().subtract(1, "week");
  return {
    key: periodStart.format("YYYY-MM-DD"),
    periodStart: periodStart.toDate(),
    periodEnd: periodEnd.toDate(),
    dueAt: periodEnd.toDate(),
    label: `${periodStart.format("D MMMM YYYY HH:mm")} – ${periodEnd.format("D MMMM YYYY HH:mm")} (${timeZone})`,
  };
};

const countGroups = (groups) => {
  const counts = new Map();
  for (const group of groups || []) {
    const region = normalizeRegion(group?._id);
    const count = Number(group?.count) || 0;
    counts.set(region, (counts.get(region) || 0) + count);
  }
  return counts;
};

export const loadWeeklyMembershipSummary = async ({
  periodStart,
  periodEnd,
  MemberModel = MemberUser,
  AlumniModel = AlumniUser,
} = {}) => {
  const pipeline = [
    {
      $match: {
        ...CURRENT_ACCOUNT_FILTER,
        joinDate: { $gte: periodStart, $lt: periodEnd },
      },
    },
    { $group: { _id: "$region", count: { $sum: 1 } } },
  ];
  const [memberGroups, alumniGroups] = await Promise.all([
    MemberModel.aggregate(pipeline),
    AlumniModel.aggregate(pipeline),
  ]);
  const members = countGroups(memberGroups);
  const alumni = countGroups(alumniGroups);
  const knownRegions = new Set(REGIONS);
  const extraRegions = [...new Set([...members.keys(), ...alumni.keys()])]
    .filter((region) => !knownRegions.has(region) && region !== "unassigned")
    .sort((left, right) => regionLabel(left).localeCompare(regionLabel(right)));
  const orderedRegions = [
    ...REGIONS,
    ...extraRegions,
    ...(members.has("unassigned") || alumni.has("unassigned") ? ["unassigned"] : []),
  ];
  const rows = orderedRegions.map((region) => {
    const memberCount = members.get(region) || 0;
    const alumniCount = alumni.get(region) || 0;
    return {
      region,
      city: regionLabel(region),
      members: memberCount,
      alumni: alumniCount,
      total: memberCount + alumniCount,
    };
  });
  return {
    rows,
    totals: rows.reduce((totals, row) => ({
      members: totals.members + row.members,
      alumni: totals.alumni + row.alumni,
      total: totals.total + row.total,
    }), { members: 0, alumni: 0, total: 0 }),
  };
};

export const buildWeeklyMembershipSummaryNotification = ({
  key,
  label,
  rows,
  totals,
}) => {
  const textRows = rows.map((row) =>
    `${row.city}: ${row.members} member${row.members === 1 ? "" : "s"}, ${row.alumni} alumn${row.alumni === 1 ? "us" : "i"}, ${row.total} total`
  );
  const htmlRows = rows.map((row) => `
    <tr>
      <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;color:#0f172a;">${escapeHtml(row.city)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;text-align:right;color:#0f172a;">${row.members}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;text-align:right;color:#0f172a;">${row.alumni}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;color:#0f172a;">${row.total}</td>
    </tr>`).join("");

  return {
    subject: `Weekly membership summary — ${label}`,
    type: REPORT_TYPE,
    entityId: key,
    text: [
      "Weekly membership summary",
      label,
      "",
      ...textRows,
      "",
      `All cities: ${totals.members} members, ${totals.alumni} alumni, ${totals.total} total`,
    ].join("\n"),
    html: `<!doctype html>
      <html lang="en">
        <body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,sans-serif;color:#0f172a;">
          <div style="max-width:680px;margin:0 auto;overflow:hidden;border-radius:16px;background:#ffffff;">
            <div style="padding:24px;background:#017363;color:#ffffff;">
              <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">Internal weekly report</div>
              <h1 style="margin:8px 0 4px;font-size:24px;line-height:1.3;font-weight:700;">New members and alumni</h1>
              <div style="font-size:15px;opacity:.9;">${escapeHtml(label)}</div>
            </div>
            <div style="padding:20px 24px 24px;">
              <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;">
                <thead>
                  <tr style="background:#f8fafc;">
                    <th style="padding:10px 8px;text-align:left;color:#475569;">City</th>
                    <th style="padding:10px 8px;text-align:right;color:#475569;">Members</th>
                    <th style="padding:10px 8px;text-align:right;color:#475569;">Alumni</th>
                    <th style="padding:10px 8px;text-align:right;color:#475569;">Total</th>
                  </tr>
                </thead>
                <tbody>${htmlRows}</tbody>
                <tfoot>
                  <tr style="background:#ecfdf5;">
                    <th style="padding:12px 8px;text-align:left;">All cities</th>
                    <th style="padding:12px 8px;text-align:right;">${totals.members}</th>
                    <th style="padding:12px 8px;text-align:right;">${totals.alumni}</th>
                    <th style="padding:12px 8px;text-align:right;">${totals.total}</th>
                  </tr>
                </tfoot>
              </table>
              <p style="margin:18px 0 0;color:#64748b;font-size:13px;line-height:1.5;">Counts use each account’s join date. Migrated account copies are excluded.</p>
            </div>
          </div>
        </body>
      </html>`,
  };
};

export const processWeeklyMembershipReport = async ({
  now = new Date(),
  config = getWeeklyMembershipReportConfig(),
  MemberModel = MemberUser,
  AlumniModel = AlumniUser,
  runGuard = reportRuns,
  send = deliverInternalNotificationEmail,
} = {}) => {
  if (!config.enabled || config.subscribers.length === 0) {
    return { status: "disabled", sent: 0 };
  }

  const period = getCompletedMembershipWeek(now, config.timeZone);
  // No late-week/startup catch-up, even if called outside the scheduled worker.
  const scheduledMinute = moment(now).tz(config.timeZone);
  if (scheduledMinute.isoWeekday() !== 7 || scheduledMinute.hour() !== 18 || scheduledMinute.minute() !== 0) {
    return { status: "not-due", sent: 0, reportKey: period.key };
  }

  const receivers = [...new Set(config.subscribers.map((email) => email.trim().toLowerCase()))];
  if (receivers.every((email) => runGuard.has(period.key, email))) {
    return { status: "already-processed", sent: 0, reportKey: period.key };
  }

  const summary = await loadWeeklyMembershipSummary({
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    MemberModel,
    AlumniModel,
  });
  const notification = buildWeeklyMembershipSummaryNotification({
    ...period,
    ...summary,
  });
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const receiver of receivers) {
    if (!runGuard.claim(period.key, receiver)) {
      skipped += 1;
      continue;
    }

    try {
      await send({ receiver, ...notification });
      sent += 1;
    } catch (error) {
      failed += 1;
      logIntegrationError("mailer", error, "weekly-membership-report");
      console.error("Weekly membership report delivery was not confirmed", {
        reportKey: period.key,
        code: error?.code,
      });
    }
  }

  return {
    status: failed ? "delivery-failed" : "processed",
    reportKey: period.key,
    sent,
    skipped,
    failed,
    totals: summary.totals,
  };
};

export const startWeeklyMembershipReportWorker = ({
  processReport = processWeeklyMembershipReport,
  config = getWeeklyMembershipReportConfig(),
  now = () => new Date(),
  schedule = setTimeout,
  cancel = clearTimeout,
  observe = runObservedJob,
} = {}) => {
  if (!config.enabled) return async () => {};
  let stopped = false;
  let running;
  let timer;
  const scheduleNext = () => {
    if (stopped) return;
    const current = now();
    timer = schedule(tick, getNextMembershipReportTime(current, config.timeZone).getTime() - current.getTime());
    timer.unref?.();
  };
  const tick = () => {
    if (stopped || running) return;
    running = Promise.resolve().then(() => observe("scheduler", "weekly-membership-report", () => processReport({ config, now: now() })))
      .catch((error) => { logOperationalError("worker.weekly-membership-report", error); console.error("Weekly membership report failed", {
        code: error?.code,
      }); })
      .finally(() => { running = null; scheduleNext(); });
  };
  scheduleNext();
  return async () => {
    stopped = true;
    cancel(timer);
    await running;
  };
};
