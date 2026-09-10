import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWeeklyMembershipSummaryNotification,
  getCompletedMembershipWeek,
  getWeeklyMembershipReportConfig,
  loadWeeklyMembershipSummary,
  processWeeklyMembershipReport,
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

test("uses the last fully completed Amsterdam Monday-to-Sunday week", () => {
  const period = getCompletedMembershipWeek(new Date("2026-09-10T10:00:00.000Z"));
  assert.equal(period.key, "2026-08-31");
  assert.equal(period.periodStart.toISOString(), "2026-08-30T22:00:00.000Z");
  assert.equal(period.periodEnd.toISOString(), "2026-09-06T22:00:00.000Z");
  assert.equal(period.dueAt.toISOString(), "2026-09-06T22:05:00.000Z");
  assert.equal(period.label, "31 August 2026 – 6 September 2026");
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

const deliveryHarness = () => {
  const records = new Map();
  const DeliveryModel = {
    countDocuments: async ({ _id }) => _id.$in.filter((id) => records.get(id)?.attemptedAt).length,
    findOneAndUpdate: async (query, update) => {
      if (records.get(query._id)?.attemptedAt) {
        const error = new Error("duplicate");
        error.code = 11000;
        throw error;
      }
      const record = { _id: query._id, ...update.$setOnInsert, ...update.$set };
      records.set(query._id, record);
      return structuredClone(record);
    },
    updateOne: async (query, update) => {
      const record = records.get(query._id);
      Object.assign(record, update.$set);
      for (const key of Object.keys(update.$unset || {})) delete record[key];
    },
  };
  return { records, DeliveryModel };
};

test("sends each recipient once even when the scheduler processes the week again", async () => {
  const harness = deliveryHarness();
  const messages = [];
  const dependencies = {
    now: new Date("2026-09-10T10:00:00.000Z"),
    config: {
      enabled: true,
      subscribers: ["one@example.com", "two@example.com"],
      timeZone: "Europe/Amsterdam",
    },
    MemberModel: aggregateModel([{ _id: "amsterdam", count: 2 }]),
    AlumniModel: aggregateModel([{ _id: "amsterdam", count: 1 }]),
    DeliveryModel: harness.DeliveryModel,
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
  assert.ok([...harness.records.values()].every((record) => record.completedAt));
});

test("records an ambiguous provider failure and does not risk a duplicate retry", async () => {
  const harness = deliveryHarness();
  let calls = 0;
  const dependencies = {
    now: new Date("2026-09-10T10:00:00.000Z"),
    config: {
      enabled: true,
      subscribers: ["team@example.com"],
      timeZone: "Europe/Amsterdam",
    },
    MemberModel: aggregateModel([]),
    AlumniModel: aggregateModel([]),
    DeliveryModel: harness.DeliveryModel,
    send: async () => { calls += 1; throw new Error("timeout"); },
  };
  const first = await processWeeklyMembershipReport(dependencies);
  const replay = await processWeeklyMembershipReport(dependencies);
  assert.equal(first.status, "delivery-failed");
  assert.equal(replay.status, "already-processed");
  assert.equal(calls, 1);
  assert.equal([...harness.records.values()][0].lastDeliveryError,
    "Provider delivery failed or was not confirmed");
});
