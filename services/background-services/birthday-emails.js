import moment from "moment-timezone";
import MemberUser from "../../models/MemberUser.js";
import AlumniUser from "../../models/AlumniUser.js";
import { createEmailRunGuard, isEmailSchedulerProcess } from "./email-run-guard.js";
const birthdayRuns = createEmailRunGuard();
import { queueDomakinTemplateEmail } from "./domakin-mailer.js";
import { BIRTHDAY_TEMPLATE } from "../../util/config/defines.js";
import { CURRENT_ACCOUNT_FILTER } from "../../util/subscriptions/policy.js";
import { logIntegrationError, logOperationalError } from "../../middleware/axiom-logger.js";
import { runObservedJob } from "../monitoring/job-history.js";

export const BIRTHDAY_EMAIL_TIME_ZONE = "Europe/Amsterdam";
export const BIRTHDAY_EMAIL_HOUR = 10;
export const BIRTHDAY_EMAIL_INTERVAL_MS = 60 * 1000;

export const getBirthdayWorkerConfig = (env = process.env) => {
  const explicitlyConfigured = env.BIRTHDAY_EMAIL_WORKER_ENABLED !== undefined;
  return {
    enabled: isEmailSchedulerProcess(env) && (explicitlyConfigured
      ? env.BIRTHDAY_EMAIL_WORKER_ENABLED === "true"
      : env.NODE_ENV === "production"),
    timeZone: BIRTHDAY_EMAIL_TIME_ZONE,
  };
};

export const getBirthdaySchedule = (now = new Date(), timeZone = BIRTHDAY_EMAIL_TIME_ZONE) => {
  const local = moment(now).tz(timeZone);
  const dueAt = local.clone().startOf("day").hour(BIRTHDAY_EMAIL_HOUR);
  return {
    dateKey: local.format("YYYY-MM-DD"),
    month: Number(local.format("M")),
    day: Number(local.format("D")),
    dueAt: dueAt.toDate(),
  };
};

const birthdayQuery = ({ month, day }) => ({
  ...CURRENT_ACCOUNT_FILTER,
  birth: { $type: "date" },
  $expr: {
    $and: [
      { $eq: [{ $month: { date: "$birth", timezone: "UTC" } }, month] },
      { $eq: [{ $dayOfMonth: { date: "$birth", timezone: "UTC" } }, day] },
    ],
  },
});

export const loadBirthdayRecipients = async ({
  month,
  day,
  MemberModel = MemberUser,
  AlumniModel = AlumniUser,
} = {}) => {
  const query = birthdayQuery({ month, day });
  const select = "_id name surname email birth";
  const [members, alumni] = await Promise.all([
    MemberModel.find(query).select(select).lean(),
    AlumniModel.find(query).select(select).lean(),
  ]);

  // An account migration should never create two birthday emails to one inbox.
  const unique = new Map();
  for (const [accountType, records] of [["member", members], ["alumni", alumni]]) {
    for (const account of records || []) {
      const email = String(account?.email || "").trim().toLowerCase();
      if (!email || unique.has(email)) continue;
      unique.set(email, { ...account, email, accountType });
    }
  }
  return [...unique.values()];
};

// The balloon-pop/confetti animation and green Bulgarian Society Netherlands
// header/footer shell live in Domakin Mailer's own "birthday" template
// (templates/bulgariansociety/birthday--<uuid>.html); this only supplies the
// per-recipient variable.
export const birthdayNotification = ({ name }) => {
  const firstName = String(name || "there").trim() || "there";
  return { templateId: BIRTHDAY_TEMPLATE, templateVariables: { name: firstName } };
};

export async function deliverBirthdayEmail({ receiver, notification, send = queueDomakinTemplateEmail }) {
  await send(notification.templateId, receiver, notification.templateVariables);
}

export const processBirthdayEmails = async ({
  now = new Date(),
  config = getBirthdayWorkerConfig(),
  MemberModel = MemberUser,
  AlumniModel = AlumniUser,
  runGuard = birthdayRuns,
  send = deliverBirthdayEmail,
} = {}) => {
  if (!config.enabled) return { status: "disabled", sent: 0 };
  const schedule = getBirthdaySchedule(now, config.timeZone);
  if (new Date(now).getTime() < schedule.dueAt.getTime()) {
    return { status: "not-due", sent: 0, dateKey: schedule.dateKey };
  }

  const recipients = await loadBirthdayRecipients({
    ...schedule,
    MemberModel,
    AlumniModel,
  });
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const recipient of recipients) {
    if (!runGuard.claim(schedule.dateKey, recipient.email)) {
      skipped += 1;
      continue;
    }

    try {
      await send({
        receiver: recipient.email,
        notification: birthdayNotification({ name: recipient.name }),
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      logIntegrationError("mailer", error, "birthday-email");
      console.error("Birthday email delivery was not confirmed", { dateKey: schedule.dateKey, code: error?.code });
    }
  }

  return {
    status: failed ? "delivery-failed" : "processed",
    dateKey: schedule.dateKey,
    sent,
    skipped,
    failed,
  };
};

export const startBirthdayEmailWorker = ({
  intervalMs = BIRTHDAY_EMAIL_INTERVAL_MS,
  process = processBirthdayEmails,
  config = getBirthdayWorkerConfig(),
} = {}) => {
  if (!config.enabled) return async () => {};
  let stopped = false;
  let running;
  const tick = () => {
    if (stopped || running) return;
    running = runObservedJob("scheduler", "birthday-emails", () => process({ config }))
      .catch((error) => { logOperationalError("worker.birthday-email", error); console.error("Birthday email worker failed; retrying on the next tick", { code: error?.code }); })
      .finally(() => { running = null; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
};
