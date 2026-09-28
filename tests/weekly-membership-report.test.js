import { createEmailRunGuard } from "../services/background-services/email-run-guard.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWeeklyMembershipSummaryNotification,
  getCompletedMembershipWeek,
  getWeeklyMembershipReportConfig,
  loadWeeklyMembershipSummary,
  processWeeklyMembershipReport,
  getNextMembershipReportTime,
  startWeeklyMembershipReportWorker,
} from "../services/background-services/weekly-membership-report.js";

const aggregateModel = (groups) => ({
  aggregate: async () => structuredClone(groups),
});

test("weekly reports follow internal notifications and production-safe overrides", () => {
  assert.deepEqual(getWeeklyMembershipReportConfig({
    INTERNAL_NOTIFICATIONS_ENABLED: "true",
    INTERNAL_NOTIFICATION_SUBSCRIBERS: "team@example.com",
    WEEKLY_MEMBERSHIP_REPORT_ENABLED: "true",
  }), {
    enabled: true,
    subscribers: ["team@example.com"],
    timeZone: "Europe/Amsterdam",
  });
  assert.equal(getWeeklyMembershipReportConfig({
    INTERNAL_NOTIFICATIONS_ENABLED: "true",
    WEEKLY_MEMBERSHIP_REPORT_ENABLED: "false",
  }).enabled, false);
  assert.equal(getWeeklyMembershipReportConfig({
    NODE_ENV: "production",
    INTERNAL_NOTIFICATIONS_ENABLED: "true",
  }).enabled, true);
  assert.equal(getWeeklyMembershipReportConfig({
    NODE_ENV: "development",
    INTERNAL_NOTIFICATIONS_ENABLED: "true",
  }).enabled, false);
});

test("uses consecutive Amsterdam Sunday 18:00 cutoffs", () => {
  const period = getCompletedMembershipWeek(new Date("2026-09-10T10:00:00.000Z"));
  assert.equal(period.key, "2026-08-30");
  assert.equal(period.periodStart.toISOString(), "2026-08-30T16:00:00.000Z");
  assert.equal(period.periodEnd.toISOString(), "2026-09-06T16:00:00.000Z");
  assert.equal(period.dueAt.toISOString(), "2026-09-06T16:00:00.000Z");
  assert.equal(period.label, "30 August 2026 18:00 – 6 September 2026 18:00 (Europe/Amsterdam)");
});

test("groups member and alumni counts by city and keeps missing cities visible", async () => {
  const summary = await loadWeeklyMembershipSummary({
    periodStart: new Date("2026-08-30T22:00:00.000Z"),
    periodEnd: new Date("2026-09-06T22:00:00.000Z"),
    MemberModel: aggregateModel([
      { _id: "groningen", count: 3 },
      { _id: "Groningen", count: 1 },
      { _id: null, count: 2 },
    ]),
    AlumniModel: aggregateModel([
      { _id: "breda-tilburg", count: 2 },
      { _id: "groningen", count: 1 },
    ]),
  });
  const groningen = summary.rows.find((row) => row.region === "groningen");
  const breda = summary.rows.find((row) => row.region === "breda_tilburg");
  const unassigned = summary.rows.find((row) => row.region === "unassigned");
  assert.deepEqual(groningen, {
    region: "groningen", city: "Groningen", members: 4, alumni: 1, total: 5,
  });
  assert.equal(breda.alumni, 2);
  assert.equal(unassigned.members, 2);
  assert.deepEqual(summary.totals, { members: 6, alumni: 3, total: 9 });
  assert.equal(summary.rows.length, 9);
});

test("builds a privacy-minimal city table", () => {
  const notification = buildWeeklyMembershipSummaryNotification({
    key: "2026-08-31",
    label: "31 August 2026 – 6 September 2026",
    rows: [{ city: "Groningen", members: 2, alumni: 1, total: 3 }],
    totals: { members: 2, alumni: 1, total: 3 },
  });
  assert.match(notification.subject, /31 August 2026/);
  assert.match(notification.text, /Groningen: 2 members, 1 alumnus, 3 total/);
  assert.match(notification.html, /<th[^>]*>Members<\/th>/);
  assert.doesNotMatch(notification.text, /@/);
  assert.equal(notification.type, "weekly-membership-summary");
});


test("sends each recipient once even when the scheduler processes the week again", async () => {
  const runGuard = createEmailRunGuard();
  const messages = [];
  const dependencies = {
    now: new Date("2026-09-13T16:00:00.000Z"),
    config: {
      enabled: true,
      subscribers: ["one@example.com", "two@example.com"],
      timeZone: "Europe/Amsterdam",
    },
    MemberModel: aggregateModel([{ _id: "amsterdam", count: 2 }]),
    AlumniModel: aggregateModel([{ _id: "amsterdam", count: 1 }]),
    runGuard,
    send: async (message) => messages.push(message),
  };
  const first = await processWeeklyMembershipReport(dependencies);
  const replay = await processWeeklyMembershipReport(dependencies);
  assert.equal(first.status, "processed");
  assert.equal(first.sent, 2);
  assert.equal(replay.status, "already-processed");
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(({ receiver }) => receiver), [
    "one@example.com", "two@example.com",
  ]);
});

test("an ambiguous provider failure is not retried within the same process", async () => {
  const runGuard = createEmailRunGuard();
  let calls = 0;
  const dependencies = {
    now: new Date("2026-09-13T16:00:00.000Z"),
    config: {
      enabled: true,
      subscribers: ["team@example.com"],
      timeZone: "Europe/Amsterdam",
    },
    MemberModel: aggregateModel([]),
    AlumniModel: aggregateModel([]),
    runGuard,
    send: async () => { calls += 1; throw new Error("timeout"); },
  };
  const first = await processWeeklyMembershipReport(dependencies);
  const replay = await processWeeklyMembershipReport(dependencies);
  assert.equal(first.status, "delivery-failed");
  assert.equal(replay.status, "already-processed");
  assert.equal(calls, 1);
});

test("next run is strictly future and follows Amsterdam daylight saving", () => {
  for (const [now, expected] of [
    ["2026-09-28T10:00:00Z", "2026-10-04T16:00:00.000Z"],
    ["2026-09-27T15:59:59Z", "2026-09-27T16:00:00.000Z"],
    ["2026-09-27T16:00:00Z", "2026-10-04T16:00:00.000Z"],
    ["2026-03-22T17:00:00Z", "2026-03-29T16:00:00.000Z"],
    ["2026-10-18T16:00:00Z", "2026-10-25T17:00:00.000Z"],
  ]) assert.equal(getNextMembershipReportTime(new Date(now)).toISOString(), expected);
  const spring = getCompletedMembershipWeek(new Date("2026-03-29T16:00:00Z"));
  const autumn = getCompletedMembershipWeek(new Date("2026-10-25T17:00:00Z"));
  assert.equal((spring.periodEnd - spring.periodStart) / 3600000, 167);
  assert.equal((autumn.periodEnd - autumn.periodStart) / 3600000, 169);
});

test("does not catch up outside the scheduled Sunday minute", async () => {
  for (const now of ["2026-09-28T10:00:00Z", "2026-09-27T15:59:59Z", "2026-09-27T16:01:00Z"]) {
    const result = await processWeeklyMembershipReport({
      now: new Date(now),
      config: { enabled: true, subscribers: ["team@example.com"], timeZone: "Europe/Amsterdam" },
      MemberModel: { aggregate() { assert.fail("Must not query reports outside schedule"); } },
      send() { assert.fail("Must not send outside schedule"); },
    });
    assert.equal(result.status, "not-due");
  }
});

test("worker schedules without sending on startup or restart and cancels on shutdown", async () => {
  let current = new Date("2026-09-28T10:00:00Z");
  const scheduled = [];
  const sent = [];
  const cancelled = [];
  const options = {
    config: { enabled: true, timeZone: "Europe/Amsterdam" },
    now: () => current,
    schedule: (callback, delay) => { const timer = { callback, delay, unref() {} }; scheduled.push(timer); return timer; },
    cancel: timer => cancelled.push(timer),
    observe: (_source, _name, work) => work(),
    processReport: async ({ now }) => sent.push(now),
  };
  const stop = startWeeklyMembershipReportWorker(options);
  assert.equal(sent.length, 0);
  assert.equal(scheduled[0].delay, new Date("2026-10-04T16:00:00Z") - current);
  current = new Date("2026-10-04T16:00:00Z");
  scheduled[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(scheduled.length, 2);
  await stop();
  assert.equal(cancelled[0], scheduled[1]);
  scheduled[1].callback();
  assert.equal(sent.length, 1);
  const stopRestart = startWeeklyMembershipReportWorker(options);
  assert.equal(sent.length, 1);
  assert.equal(scheduled[2].delay, 7 * 24 * 3600000);
  await stopRestart();
  startWeeklyMembershipReportWorker({ ...options, config: { enabled: false } });
  assert.equal(scheduled.length, 3);
});
