import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateEventAverages, calculateEventTotals, calculateMemberAverages, memberMonthSnapshots, refreshEventAverages, refreshMemberAverages,
  initializeAcademicYearStatistics,
  statisticsRegion, STATISTICS_REGIONS,
} from "../services/background-services/regional-averages.js";
import regionalAveragesMigration from "../migrations/018-regional-statistics-averages.js";
import calculationTypeMigration from "../migrations/019-statistics-calculation-type.js";
import nationalRegionsMigration from "../migrations/020-national-statistics-regions.js";
import memberTicketShareMigration from "../migrations/021-member-ticket-share.js";
import { academicYearLabel, academicYearRange } from "../util/config/academic-year.js";
import Statistics, { STATISTICS_CALCULATION_TYPES } from "../models/Statistics.js";

const event = (region, tickets, overrides = {}) => ({
  region, status: "archived", createdAt: new Date("2026-09-01T12:00:00Z"),
  date: new Date("2026-09-03T12:00:00Z"),
  product: { guest: { price: 10 }, member: { price: 5 } }, guestList: tickets,
  ...overrides,
});

test("statistics accept the four calculation cadences and default to on demand", () => {
  assert.deepEqual(STATISTICS_CALCULATION_TYPES, ["monthly", "on-demand", "weekly", "yearly"]);
  assert.equal(new Statistics({ type: "event" }).calculationType, "on-demand");
  for (const calculationType of STATISTICS_CALCULATION_TYPES) {
    // The async uniqueness plugin requires a database; schema validation does not.
    // eslint-disable-next-line no-sync
    assert.equal(new Statistics({ type: "event", calculationType }).validateSync(), undefined);
  }
  // eslint-disable-next-line no-sync
  assert.ok(new Statistics({ type: "event", calculationType: "daily" }).validateSync());
});

test("event averages pool member/guest tickets and include recorded partial refunds", () => {
  const events = [
    event("amsterdam", [
      { type: "guest" }, { type: "member", refunded: true, refundAmountCents: 200 },
    ]),
    event("groningen", [{ type: "member" }], {
      createdAt: new Date("2026-09-02T12:00:00Z"),
      date: new Date("2026-09-04T12:00:00Z"),
    }),
  ];
  assert.deepEqual(calculateEventAverages(events), {
    eventCount: 2, averageEventPresence: 48, averageEventTicketCount: 1.5,
    averageEventTicketTypeRatio: 66.67, memberTickets: 2, guestTickets: 1,
    averageEventRevenue: 9, averageEventRefund: 1,
  });
  assert.deepEqual(calculateEventTotals(events), {
    eventCount: 2, ticketCount: 3, memberTickets: 2, guestTickets: 1,
    revenue: 18, refunds: 2,
  });
  assert.equal(calculateEventAverages([events[1]]).averageEventTicketTypeRatio, 100);
  assert.equal(calculateEventAverages([event("amsterdam", [])]).averageEventTicketTypeRatio, null);
  assert.equal(calculateEventAverages([event("amsterdam", [], { cancellationRequestedAt: new Date() })]).eventCount, 0);
  assert.deepEqual(calculateEventTotals([event("amsterdam", [
    { type: "guest", refunded: true, refundAmountCents: null },
  ])]), { eventCount: 1, ticketCount: 1, memberTickets: 0, guestTickets: 1,
    revenue: 0, refunds: 10 });
});

test("ticket share migration updates stored regional and national percentages", async () => {
  const events = [event("amsterdam", [{ type: "guest" }]), event("groningen", [{ type: "member" }])];
  const documents = ["amsterdam", "groningen", "national", "leeuwarden"].map(region => ({
    _id: region, academicYear: "2026-2027", region,
  }));
  const writes = [];
  const db = { collection(name) {
    if (name === "events") return { find: () => ({ toArray: async () => events }) };
    if (name === "statistics") return {
      find: () => ({ toArray: async () => documents }),
      updateOne: async (filter, update) => writes.push({ filter, update }),
    };
    throw new Error(`Unexpected collection ${name}`);
  } };
  await memberTicketShareMigration.up(db);
  assert.deepEqual(Object.fromEntries(writes.map(({ filter, update }) => [filter._id,
    update.$set["data.averageEventTicketTypeRatio"]])), {
    amsterdam: 0, groningen: 100, national: 50, leeuwarden: null,
  });
});

test("monthly averages use month-end active counts and new joins across regions", () => {
  const members = [
    { region: "amsterdam", status: "active", joinDate: new Date("2026-08-27T12:00:00Z"), expireDate: new Date("2027-08-27T12:00:00Z") },
    { region: "groningen", status: "active", joinDate: new Date("2026-09-10T12:00:00Z"), expireDate: new Date("2027-09-10T12:00:00Z") },
    { region: "amsterdam", status: "alumni-migrated", joinDate: new Date("2026-09-10T12:00:00Z"), expireDate: new Date("2027-09-10T12:00:00Z") },
  ];
  const result = calculateMemberAverages(members, new Date("2026-08-25T00:00:00Z"),
    new Date("2026-10-12T12:00:00Z"), new Date("2026-10-12T12:00:00Z"));
  assert.deepEqual(result, { monthCount: 3, averageActiveMembersMonth: 1.67, averageNewMembersMonth: 0.67 });
  assert.deepEqual(memberMonthSnapshots(members, new Date("2026-08-25T00:00:00Z"),
    new Date("2026-10-12T12:00:00Z"), new Date("2026-10-12T12:00:00Z")), [
    { month: "2026-08", active: 1, newMembers: 1 },
    { month: "2026-09", active: 2, newMembers: 1 },
    { month: "2026-10", active: 2, newMembers: 0 },
  ]);
});

test("active member series includes earlier members and drops expired memberships", () => {
  const members = [
    { status: "active", joinDate: new Date("2024-02-01T12:00:00Z"), expireDate: new Date("2026-09-15T12:00:00Z") },
    { status: "active", joinDate: new Date("2026-09-04T12:00:00Z"), expireDate: new Date("2027-09-04T12:00:00Z") },
  ];
  assert.deepEqual(memberMonthSnapshots(members, new Date("2026-08-25T00:00:00Z"),
    new Date("2026-12-31T12:00:00Z"), new Date("2026-10-13T12:00:00Z")), [
    { month: "2026-08", active: 1, newMembers: 0 },
    { month: "2026-09", active: 1, newMembers: 1 },
    { month: "2026-10", active: 1, newMembers: 0 },
  ]);
});

test("national source records partition into every displayed region including legacy and unassigned", () => {
  const sources = ["amsterdam", "breda", "bread", "breda_tilburg", "", null, "unknown", "netherlands"];
  const counts = Object.fromEntries(STATISTICS_REGIONS.map(region => [region, 0]));
  for (const source of sources) counts[statisticsRegion(source)]++;
  assert.equal(counts.breda_tilburg, 3);
  assert.equal(counts.unassigned, 3);
  assert.equal(Object.values(counts).reduce((total, count) => total + count, 0), sources.length);
});

test("archive refresh writes regional and pooled national figures for the event academic year", async () => {
  const events = [event("amsterdam", [{ type: "guest" }]), event("groningen", [{ type: "member" }])];
  const writes = [];
  const EventModel = { find: () => ({ select() { return this; }, lean: async () => events }) };
  const StatisticsModel = { updateOne: async (filter, update, options) => writes.push({ filter, update, options }) };
  await refreshEventAverages(events[0], { EventModel, StatisticsModel });
  const national = writes.find(write => write.filter.region === "national");
  assert.equal(national.filter.academicYear, "2026-2027");
  assert.equal(national.update.$set.data.eventCount, 2);
  assert.equal(national.update.$set.data.averageEventTicketTypeRatio, 50);
  assert.equal(writes.find(write => write.filter.region === "amsterdam").update.$set.data.eventCount, 1);
  assert.equal(writes.find(write => write.filter.region === "groningen").update.$set.data.eventCount, 1);
  assert.ok(writes.every(write => write.update.$set.calculationType === "on-demand"));
  assert.ok(writes.every(write => write.options.upsert));
});

test("weekly refresh writes member averages for each region and national", async () => {
  const writes = [];
  const members = [{ region: "amsterdam", status: "active", joinDate: new Date("2026-09-01T12:00:00Z"),
    expireDate: new Date("2027-09-01T12:00:00Z") }];
  const MemberModel = { find: () => ({ select() { return this; }, lean: async () => members }) };
  const StatisticsModel = { updateOne: async (filter, update) => writes.push({ filter, update }) };
  await refreshMemberAverages(new Date("2026-10-12T12:00:00Z"), { MemberModel, StatisticsModel });
  assert.equal(writes.find(write => write.filter.region === "national").update.$set.data.averageNewMembersMonth, 0.33);
  assert.equal(writes.find(write => write.filter.region === "amsterdam").update.$set.data.averageActiveMembersMonth, 0.67);
  assert.equal(writes.find(write => write.filter.region === "groningen").update.$set.data.averageNewMembersMonth, 0);
  assert.ok(writes.every(write => write.update.$set.calculationType === "weekly"));
});

test("25 August seeds a new academic year and leaves existing period figures untouched", async () => {
  const oldYear = "2026-2027", newYear = "2027-2028";
  const before = new Date("2027-08-24T21:59:59Z");
  const after = new Date("2027-08-25T12:00:00Z");
  const records = new Map([[`event-averages:${oldYear}:national`, { data: { eventCount: 37 } }]]);
  const archived = [event("amsterdam", [{ type: "guest" }], {
    date: new Date("2027-08-25T10:00:00Z"), createdAt: new Date("2027-08-25T08:00:00Z"),
  })];
  const members = [{ region: "amsterdam", status: "active", joinDate: after,
    expireDate: new Date("2028-08-25T10:00:00Z") }];
  const EventModel = { find: filter => ({ select() { return this; }, lean: async () =>
    archived.filter(row => row.date >= filter.$or[0].correctedDate.$gte &&
      row.date < filter.$or[0].correctedDate.$lt) }) };
  const MemberModel = { find: () => ({ select() { return this; }, lean: async () => members }) };
  const StatisticsModel = { updateOne: async (filter, update, options) => {
    assert.equal(options.upsert, true);
    assert.ok(update.$setOnInsert);
    const key = `${filter.type}:${filter.academicYear}:${filter.region}`;
    if (!records.has(key)) records.set(key, { ...filter, ...update.$setOnInsert });
  } };
  const dependencies = { EventModel, MemberModel, StatisticsModel };
  assert.equal(await initializeAcademicYearStatistics(before, dependencies), oldYear);
  assert.deepEqual(records.get(`event-averages:${oldYear}:national`).data, { eventCount: 37 });
  assert.equal(await initializeAcademicYearStatistics(after, dependencies), newYear);
  assert.equal(records.get(`event-averages:${newYear}:national`).data.eventCount, 1);
  assert.equal(records.get(`member-averages:${newYear}:national`).data.averageNewMembersMonth, 1);
  assert.equal(records.get(`event-averages:${oldYear}:national`).data.eventCount, 37);
  records.get(`member-averages:${newYear}:national`).data.averageNewMembersMonth = 7;
  const size = records.size;
  await initializeAcademicYearStatistics(after, dependencies);
  assert.equal(records.size, size);
  assert.equal(records.get(`member-averages:${newYear}:national`).data.averageNewMembersMonth, 7);
});

test("migration indexes and backfills every archived event year plus current member averages", async () => {
  const now = new Date();
  const previousYearEventDate = new Date(academicYearRange(now).start.getTime() - 86_400_000);
  const writes = [];
  let createdIndex;
  const db = { collection(name) {
    if (name === "statistics") return {
      createIndex: async (keys, options) => { createdIndex = { keys, options }; },
      updateOne: async (filter, update, options) => writes.push({ filter, update, options }),
    };
    if (name === "events") return { find: () => ({ toArray: async () => [
      event("amsterdam", [{ type: "guest" }], {
        createdAt: new Date(now.getTime() - 3_600_000), date: now,
      }),
      event("groningen", [{ type: "member" }], {
        createdAt: new Date(previousYearEventDate.getTime() - 3_600_000), date: previousYearEventDate,
      }),
    ] }) };
    if (name === "memberUsers") return { find: () => ({ toArray: async () => [{
      region: "amsterdam", status: "active", joinDate: now,
      expireDate: new Date(now.getTime() + 86_400_000),
    }] }) };
    throw new Error(`Unexpected collection: ${name}`);
  } };
  await regionalAveragesMigration.up(db);
  assert.deepEqual(createdIndex.keys, { type: 1, academicYear: 1, region: 1 });
  assert.equal(createdIndex.options.unique, true);
  assert.deepEqual(createdIndex.options.partialFilterExpression,
    { type: { $in: ["event-averages", "member-averages"] } });
  const nationalEvents = writes.find(write => write.filter.type === "event-averages" && write.filter.region === "national");
  const regionalMembers = writes.find(write => write.filter.type === "member-averages" && write.filter.region === "amsterdam");
  assert.equal(nationalEvents.filter.academicYear, academicYearLabel(now));
  assert.equal(nationalEvents.update.$set.data.eventCount, 1);
  assert.equal(writes.find(write => write.filter.type === "event-averages" &&
    write.filter.region === "national" && write.filter.academicYear === academicYearLabel(previousYearEventDate))
    .update.$set.data.eventCount, 1);
  assert.equal(regionalMembers.update.$set.data.averageNewMembersMonth > 0, true);
  assert.ok(writes.every(write => write.options.upsert));
});

test("calculation type migration labels existing averages and preserves explicit cadences", async () => {
  const rows = [
    { type: "member-averages" },
    { type: "event-averages" },
    { type: "event" },
    { type: "custom", calculationType: "yearly" },
  ];
  const db = { collection: name => {
    assert.equal(name, "statistics");
    return { updateMany: async (filter, update) => {
      for (const row of rows) {
        if (filter.type && row.type !== filter.type) continue;
        if (filter.calculationType?.$exists === false && Object.hasOwn(row, "calculationType")) continue;
        Object.assign(row, update.$set);
      }
    } };
  } };
  await calculationTypeMigration.up(db);
  assert.deepEqual(rows.map(row => row.calculationType), ["weekly", "on-demand", "on-demand", "yearly"]);
});

test("region repair migration folds Breda into Breda–Tilburg and rebuilds National", async () => {
  const now = new Date();
  const events = [event("breda", [{ type: "guest" }], {
    createdAt: new Date(now.getTime() - 3_600_000), date: now,
  })];
  const members = [{ region: "", status: "active", joinDate: now,
    expireDate: new Date(now.getTime() + 86_400_000) }];
  const documents = [{ type: "event-averages", region: "breda", academicYear: academicYearLabel(now) }];
  const db = { collection(name) {
    if (name === "statistics") return {
      createIndex: async () => {},
      updateOne: async (filter, update) => {
        const existing = documents.find(row => row.type === filter.type &&
          row.region === filter.region && row.academicYear === filter.academicYear);
        if (existing) Object.assign(existing, update.$set);
        else documents.push({ ...filter, ...update.$set });
      },
      deleteMany: async ({ region }) => {
        for (let index = documents.length - 1; index >= 0; index--) {
          if (region.$in.includes(documents[index].region)) documents.splice(index, 1);
        }
      },
    };
    const records = name === "events" ? events : members;
    return {
      updateMany: async (filter, update) => {
        for (const record of records) {
          if (filter.region.$in.includes(record.region)) record.region = update.$set.region;
        }
      },
      find: () => ({ toArray: async () => records }),
    };
  } };
  await nationalRegionsMigration.up(db);
  assert.equal(events[0].region, "breda_tilburg");
  assert.equal(documents.some(row => row.region === "breda"), false);
  assert.equal(documents.find(row => row.type === "event-averages" && row.region === "breda_tilburg").data.eventCount, 1);
  assert.equal(documents.find(row => row.type === "event-averages" && row.region === "national").data.eventCount, 1);
  assert.equal(documents.find(row => row.type === "member-averages" && row.region === "unassigned").data.averageNewMembersMonth > 0, true);
});
