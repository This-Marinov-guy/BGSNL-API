import { createHash } from "node:crypto";
import moment from "moment-timezone";
import User from "../../models/User.js";
import AlumniUser from "../../models/AlumniUser.js";
import BirthdayEmailDelivery from "../../models/BirthdayEmailDelivery.js";
import { sendEmail, useDomakinMailer } from "./email-provider.js";
import { NO_REPLY_EMAIL, NO_REPLY_EMAIL_NAME } from "../../util/config/defines.js";
import { CURRENT_ACCOUNT_FILTER } from "../../util/subscriptions/policy.js";

export const BIRTHDAY_EMAIL_TIME_ZONE = "Europe/Amsterdam";
export const BIRTHDAY_EMAIL_HOUR = 10;
export const BIRTHDAY_EMAIL_INTERVAL_MS = 60 * 1000;

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const recipientHash = (email) => createHash("sha256")
  .update(String(email).trim().toLowerCase())
  .digest("hex")
  .slice(0, 24);

const deliveryId = (dateKey, email) => `birthday:${dateKey}:${recipientHash(email)}`;
const duplicateKey = (error) => error?.code === 11000;

export const getBirthdayWorkerConfig = (env = process.env) => {
  const explicitlyConfigured = env.BIRTHDAY_EMAIL_WORKER_ENABLED !== undefined;
  return {
    enabled: explicitlyConfigured
      ? env.BIRTHDAY_EMAIL_WORKER_ENABLED === "true"
      : env.NODE_ENV === "production",
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
  MemberModel = User,
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

export const birthdayNotification = ({ name }) => {
  const firstName = String(name || "there").trim() || "there";
  return {
    subject: "Happy birthday from Bulgarian Society Netherlands!",
    text: `Happy birthday, ${firstName}!\n\nWishing you a wonderful day from everyone at Bulgarian Society Netherlands.`,
    html: `<p>Happy birthday, ${escapeHtml(firstName)}!</p><p>Wishing you a wonderful day from everyone at Bulgarian Society Netherlands.</p>`,
  };
};

export async function deliverBirthdayEmail({ receiver, notification }) {
  const delivery = sendEmail({
    from: { email: NO_REPLY_EMAIL, name: NO_REPLY_EMAIL_NAME },
    to: [{ email: receiver }],
    ...notification,
    category: "birthday-greeting",
  });
  let timeout;
  try {
    await Promise.race([
      delivery,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Mail delivery timed out")),
          useDomakinMailer() ? 100000 : 60000
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export const processBirthdayEmails = async ({
  now = new Date(),
  config = getBirthdayWorkerConfig(),
  MemberModel = User,
  AlumniModel = AlumniUser,
  DeliveryModel = BirthdayEmailDelivery,
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
    const id = deliveryId(schedule.dateKey, recipient.email);
    try {
      await DeliveryModel.create({
        _id: id,
        dateKey: schedule.dateKey,
        recipientHash: recipientHash(recipient.email),
        accountId: String(recipient._id),
        accountType: recipient.accountType,
        attemptedAt: new Date(now),
      });
    } catch (error) {
      if (duplicateKey(error)) {
        skipped += 1;
        continue;
      }
      throw error;
    }

    try {
      await send({
        receiver: recipient.email,
        notification: birthdayNotification({ name: recipient.name }),
      });
      await DeliveryModel.updateOne(
        { _id: id, completedAt: { $exists: false } },
        { $set: { completedAt: new Date() }, $unset: { lastDeliveryError: 1 } }
      );
      sent += 1;
    } catch (error) {
      await DeliveryModel.updateOne(
        { _id: id },
        { $set: { lastDeliveryError: "Provider delivery failed or was not confirmed" } }
      );
      failed += 1;
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
    running = process({ config })
      .catch((error) => console.error("Birthday email worker failed; retrying on the next tick", { code: error?.code }))
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
