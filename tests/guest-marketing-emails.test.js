import assert from "node:assert/strict";
import test from "node:test";
import { ACADEMIC_YEAR_DATES, academicYearLabel, academicYearSchedule } from "../util/config/academic-year.js";
import { findGuestMarketingAudience, guestMarketingKey, recordGuestMarketingEmail,
  removeGuestMarketingEmail } from "../services/events/guest-marketing-emails.js";
import GuestMarketingEmail from "../models/GuestMarketingEmail.js";
import mediaResetMigration from "../migrations/013-august-25-media-reset.js";
import guestBackfillMigration from "../migrations/014-backfill-guest-marketing-emails.js";

const event = { _id: "507f1f77bcf86cd799439011", date: new Date("2026-09-12T12:00:00Z"), region: "groningen" };
const query = rows => ({ select() { return this; }, sort() { return this; }, lean: async () => rows });

test("term dates and the reset date share one Amsterdam academic year configuration", () => {
  assert.deepEqual(ACADEMIC_YEAR_DATES, {
    term1: { month: 11, day: 15 }, term2: { month: 2, day: 15 },
    term3: { month: 5, day: 15 }, term4: { month: 7, day: 15 },
    resetDate: { month: 8, day: 25 },
  });
  assert.equal(academicYearLabel("2026-08-24T21:59:59Z"), "2025-2026");
  assert.equal(academicYearLabel("2026-08-24T22:00:00Z"), "2026-2027");
  const schedule = academicYearSchedule("2026-10-01T12:00:00Z");
  assert.equal(schedule.academicYear, "2026-2027");
  assert.deepEqual(Object.fromEntries(["term1", "term2", "term3", "term4", "resetDate"]
    .map(key => [key, schedule[key].toISOString()])), {
    term1: "2026-11-14T23:00:00.000Z", term2: "2027-02-14T23:00:00.000Z",
    term3: "2027-05-14T22:00:00.000Z", term4: "2027-07-14T22:00:00.000Z",
    resetDate: "2027-08-24T22:00:00.000Z",
  });
  assert.deepEqual(guestMarketingKey(event, " Guest@Example.test "),
    { email: "guest@example.test", academicYear: "2026-2027", region: "groningen" });
});

test("guest ticket records deduplicate by academic year, region and address; signup removes every year", async () => {
  const writes = [], deletes = [];
  const GuestModel = {
    updateOne: async (...args) => { writes.push(args); },
    deleteMany: async filter => { deletes.push(filter); },
  };
  const AccountModel = { exists: async () => false };
  const options = { GuestModel, MemberModel: AccountModel, AlumniModel: AccountModel,
    now: new Date("2026-10-01T10:00:00Z") };
  const first = await recordGuestMarketingEmail(event, " GUEST@example.test ", options);
  const second = await recordGuestMarketingEmail(event, "guest@example.test", options);
  assert.deepEqual(first, second);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0][0], writes[1][0]);
  assert.equal(writes[0][1].$addToSet.eventIds, event._id);
  await removeGuestMarketingEmail(" GUEST@example.test ", { GuestModel });
  assert.deepEqual(deletes, [{ email: "guest@example.test" }]);
});

test("the same regional email gets a new row in a later academic year, but not twice in one year", async () => {
  const index = GuestMarketingEmail.schema.indexes().find(([, options]) => options.name === "unique_year_region_email");
  assert.deepEqual(index[0], { academicYear: 1, region: 1, email: 1 });
  assert.equal(index[1].unique, true);
  const rows = new Set();
  const GuestModel = {
    updateOne: async ({ academicYear, region, email }) => {
      const key = `${academicYear}:${region}:${email}`;
      rows.add(key);
    },
  };
  const AccountModel = { exists: async () => false };
  const options = { GuestModel, MemberModel: AccountModel, AlumniModel: AccountModel };
  const nextYearEvent = { ...event, date: new Date("2027-09-12T12:00:00Z") };
  const first = await recordGuestMarketingEmail(event, "GUEST@example.test", options);
  assert.deepEqual(await recordGuestMarketingEmail(event, "guest@example.test", options), first);
  assert.equal((await recordGuestMarketingEmail(nextYearEvent, "guest@example.test", options)).academicYear, "2027-2028");
  assert.deepEqual([...rows], ["2026-2027:groningen:guest@example.test", "2027-2028:groningen:guest@example.test"]);
});

test("registered accounts are not added to the guest audience", async () => {
  let writes = 0;
  const result = await recordGuestMarketingEmail(event, "member@example.test", {
    GuestModel: { updateOne: async () => { writes++; } },
    MemberModel: { exists: async () => true }, AlumniModel: { exists: async () => false },
  });
  assert.equal(result, null);
  assert.equal(writes, 0);
});

test("signup racing a guest ticket insert clears the new guest row", async () => {
  let checks = 0, removed;
  const result = await recordGuestMarketingEmail(event, "guest@example.test", {
    GuestModel: { exists: async () => false, updateOne: async () => ({ upsertedCount: 1 }), deleteMany: async filter => { removed = filter; } },
    MemberModel: { exists: async () => ++checks > 1 },
    AlumniModel: { exists: async () => false },
  });
  assert.equal(result, null);
  assert.deepEqual(removed, { email: "guest@example.test" });
});

test("regional academic-year audience requires consent and excludes opt-outs and accounts", async () => {
  const emails = ["allowed@example.test", "optout@example.test", "member@example.test", "no-consent@example.test"];
  const rows = emails.map(email => ({ email, academicYear: "2026-2027", region: "groningen" }));
  const result = await findGuestMarketingAudience({ academicYear: "2026-2027", region: "groningen" }, {
    GuestModel: { find: filter => { assert.deepEqual(filter, { academicYear: "2026-2027", region: "groningen" }); return query(rows); } },
    MarketingModel: { find: () => query([
      { email: emails[0], consent: { granted: true }, unsubscribed: false },
      { email: emails[1], consent: { granted: true }, unsubscribed: true },
      { email: emails[2], consent: { granted: true }, unsubscribed: false },
      { email: emails[3], consent: { granted: false }, unsubscribed: false },
    ]) },
    MemberModel: { find: () => query([{ email: emails[2] }]) },
    AlumniModel: { find: () => query([]) },
  });
  assert.deepEqual(result.map(row => row.email), ["allowed@example.test"]);
});

test("media migration moves only the old annual August 15 cutoff", async () => {
  const writes = [];
  const oldDue = new Date("2027-08-15T01:00:00Z");
  const customDue = new Date("2027-08-15T12:00:00Z");
  const db = { collection: name => ({
    find: () => [
      { _id: `${name}:old`, mediaCleanupDueAt: oldDue, dueAt: oldDue },
      { _id: `${name}:custom`, mediaCleanupDueAt: customDue, dueAt: customDue },
    ],
    updateOne: async (...args) => { writes.push([name, ...args]); },
  }) };
  await mediaResetMigration.up(db);
  assert.equal(writes.length, 2);
  assert.equal(writes[0][2].$set.mediaCleanupDueAt.toISOString(), "2027-08-25T01:00:00.000Z");
  assert.equal(writes[1][2].$set.dueAt.toISOString(), "2027-08-25T01:00:00.000Z");
});

test("historical guest tickets backfill by event year and region, excluding accounts and refunds", async () => {
  const writes = [], indexes = [];
  const oldEvent = { _id: "507f1f77bcf86cd799439012", region: "groningen", date: new Date("2026-08-24T21:59:59Z"),
    guestList: [{ email: "guest@example.test", type: "guest" }] };
  const newEvent = { ...event, guestList: [
    { email: " GUEST@example.test ", type: "guest", timestamp: new Date("2026-09-01") },
    { email: "GUEST@example.test", type: "guest", timestamp: new Date("2026-09-02") },
    { email: "member@example.test", type: "guest" },
    { email: "refund@example.test", type: "guest", refunded: true },
    { email: "member-ticket@example.test", type: "member" },
  ] };
  const db = { collection: name => ({
    find: () => name === "events" ? [oldEvent, newEvent] : name === "memberUsers" ? [{ email: "member@example.test" }] : [],
    updateOne: async (...args) => { writes.push(args); },
    createIndex: async (...args) => { indexes.push(args); },
  }) };
  await guestBackfillMigration.up(db);
  assert.deepEqual(writes.map(row => row[0].academicYear), ["2025-2026", "2026-2027"]);
  assert.deepEqual(writes.map(row => row[0].email), ["guest@example.test", "guest@example.test"]);
  assert.equal(writes[1][1].$addToSet.eventIds.$each.length, 1);
  assert.equal(indexes.length, 2);
});
