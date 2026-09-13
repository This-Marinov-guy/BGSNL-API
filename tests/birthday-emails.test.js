import { createEmailRunGuard } from "../services/background-services/email-run-guard.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  birthdayNotification,
  deliverBirthdayEmail,
  getBirthdaySchedule,
  getBirthdayWorkerConfig,
  loadBirthdayRecipients,
  processBirthdayEmails,
} from "../services/background-services/birthday-emails.js";
import { BIRTHDAY_TEMPLATE } from "../util/config/defines.js";

const recordsModel = (records, seen) => ({
  find(query) {
    seen.push(query);
    return { select: () => ({ lean: async () => structuredClone(records) }) };
  },
});


test("birthday scheduler uses 10:00 Europe/Amsterdam across daylight saving time", () => {
  const summer = getBirthdaySchedule(new Date("2026-09-10T08:00:00.000Z"));
  assert.equal(summer.dateKey, "2026-09-10");
  assert.equal(summer.dueAt.toISOString(), "2026-09-10T08:00:00.000Z");
  const winter = getBirthdaySchedule(new Date("2026-01-10T09:00:00.000Z"));
  assert.equal(winter.dueAt.toISOString(), "2026-01-10T09:00:00.000Z");
});

test("scheduler defaults to production and has a deliberate development override", () => {
  assert.equal(getBirthdayWorkerConfig({ NODE_ENV: "production" }).enabled, true);
  assert.equal(getBirthdayWorkerConfig({ NODE_ENV: "development" }).enabled, false);
  assert.equal(getBirthdayWorkerConfig({ NODE_ENV: "development", BIRTHDAY_EMAIL_WORKER_ENABLED: "true" }).enabled, true);
  assert.equal(getBirthdayWorkerConfig({ NODE_ENV: "production", BIRTHDAY_EMAIL_WORKER_ENABLED: "false" }).enabled, false);
});

test("birthday recipients query both account collections and never duplicate an inbox", async () => {
  const seen = [];
  const recipients = await loadBirthdayRecipients({
    month: 9,
    day: 10,
    MemberModel: recordsModel([{ _id: "member_1", email: "same@example.test", name: "Member" }], seen),
    AlumniModel: recordsModel([
      { _id: "alumni_1", email: "SAME@example.test", name: "Alumni" },
      { _id: "alumni_2", email: "alumni@example.test", name: "Alumni" },
    ], seen),
  });
  assert.equal(recipients.length, 2);
  assert.equal(recipients[0].accountType, "member");
  assert.equal(seen.length, 2);
  assert.equal(seen[0].$expr.$and[0].$eq[1], 9);
  assert.equal(seen[0].$expr.$and[1].$eq[1], 10);
});

test("birthday scheduler sends once per inbox per day within one process", async () => {
  const runGuard = createEmailRunGuard();
  const messages = [];
  const dependencies = {
    now: new Date("2026-09-10T08:00:00.000Z"),
    config: { enabled: true, timeZone: "Europe/Amsterdam" },
    MemberModel: recordsModel([{ _id: "member_1", email: "member@example.test", name: "Mila" }], []),
    AlumniModel: recordsModel([{ _id: "alumni_1", email: "alumni@example.test", name: "Alex" }], []),
    runGuard,
    send: async (message) => messages.push(message),
  };
  const first = await processBirthdayEmails(dependencies);
  const replay = await processBirthdayEmails(dependencies);
  assert.deepEqual({ sent: first.sent, skipped: first.skipped, failed: first.failed }, { sent: 2, skipped: 0, failed: 0 });
  assert.deepEqual({ sent: replay.sent, skipped: replay.skipped, failed: replay.failed }, { sent: 0, skipped: 2, failed: 0 });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].notification.templateId, BIRTHDAY_TEMPLATE);
});

test("birthday notification targets the Domakin Mailer birthday template with the recipient's name", () => {
  const message = birthdayNotification({ name: "Mila" });
  assert.equal(message.templateId, BIRTHDAY_TEMPLATE);
  assert.deepEqual(message.templateVariables, { name: "Mila" });
});

test("birthday notification falls back to a friendly greeting for a blank name", () => {
  const message = birthdayNotification({ name: "   " });
  assert.deepEqual(message.templateVariables, { name: "there" });
});

test("delivering a birthday email queues it through Domakin Mailer with the recipient and variables", async () => {
  const calls = [];
  await deliverBirthdayEmail({
    receiver: "mila@example.test",
    notification: birthdayNotification({ name: "Mila" }),
    send: async (...args) => calls.push(args),
  });
  assert.deepEqual(calls, [[BIRTHDAY_TEMPLATE, "mila@example.test", { name: "Mila" }]]);
});


test("only one PM2 worker runs email schedules without delivery tables", () => {
  assert.equal(getBirthdayWorkerConfig({ NODE_ENV: "production", NODE_APP_INSTANCE: "0" }).enabled, true);
  assert.equal(getBirthdayWorkerConfig({ NODE_ENV: "production", NODE_APP_INSTANCE: "1" }).enabled, false);
});
