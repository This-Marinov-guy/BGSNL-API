import assert from "node:assert/strict";
import test from "node:test";
import { getMembers, getEventsAnalytics, getMemberStatistics, getEventStatistics } from "../controllers/dashboard-controllers.js";
import MemberUser from "../models/MemberUser.js";
import Event from "../models/Event.js";
import { DASHBOARD_ACCESS } from "../util/config/defines.js";

const response = () => {
  let body;
  return { status() { return this; }, json(value) { body = value; return this; }, get body() { return body; } };
};

test("member analytics expose the original join date for the timeline", async (t) => {
  const joined = new Date("2026-09-02T12:00:00Z");
  t.mock.method(MemberUser, "find", () => ({ select() { return this; }, lean: async () => [{
    _id: "member_1", name: "Test", surname: "Member", email: "test@example.com",
    roles: ["member"], region: "amsterdam", status: "active",
    joinDate: joined, purchaseDate: new Date("2026-10-02T12:00:00Z"),
    expireDate: new Date("2027-10-02T12:00:00Z"), tickets: [], subscription: {},
  }] }));
  const res = response();
  let error;
  await getMembers({ query: {}, regionScope: { member: null } }, res, (value) => { error = value; });
  assert.equal(error, undefined);
  assert.equal(res.body.members[0].joinDate, joined);
  assert.equal(res.body.summary.totalActive, 1);
});

test("event guest totals exclude refunded tickets", async (t) => {
  t.mock.method(Event, "find", () => ({ select() { return this; }, sort() { return this; }, lean: async () => [{
    _id: "event_1", title: "Autumn social", date: new Date("2026-09-14T12:00:00Z"),
    region: "amsterdam", status: "opened", isFree: false, product: { guest: { price: 10 } },
    guestList: [
      { _id: "ticket_1", type: "guest", name: "A", status: 0, refunded: false },
      { _id: "ticket_2", type: "guest", name: "B", status: 0, refunded: true },
    ],
  }] }));
  const res = response();
  let error;
  await getEventsAnalytics({ query: {}, regionScope: { event: null } }, res, (value) => { error = value; });
  assert.equal(error, undefined);
  assert.equal(res.body.events[0].totalGuests, 1);
  assert.equal(res.body.summary.totalGuests, 1);
  assert.equal(res.body.summary.totalTicketsSold, 2);
  assert.equal(res.body.summary.totalRevenue, 10);
  assert.equal(res.body.events[0].ticketCount, 2);
  assert.equal(res.body.events[0].guestTickets, 2);
  assert.equal(res.body.events[0].refunds, 10);
  assert.equal(res.body.events[0].netRevenue, 10);
  assert.equal(res.body.summary.averages.eventCount, 1);
  assert.equal(res.body.summary.averages.averageEventTicketCount, 2);
});

test("event date filters use Amsterdam calendar days", async (t) => {
  let filter;
  t.mock.method(Event, "find", (query) => {
    filter = query;
    return { select() { return this; }, sort() { return this; }, lean: async () => [] };
  });
  const res = response();
  await getEventsAnalytics({ query: { from: "2026-08-25", to: "2026-09-30" }, regionScope: { event: null } }, res, () => {});
  assert.equal(filter.$or[0].correctedDate.$gte.toISOString(), "2026-08-24T22:00:00.000Z");
  assert.equal(filter.$or[1].date.$lte.toISOString(), "2026-09-30T21:59:59.999Z");
});

test("statistics region filters include legacy Breda and expose unassigned accounts", async (t) => {
  const memberQueries = [], eventQueries = [];
  t.mock.method(MemberUser, "find", (query) => {
    memberQueries.push(query);
    return { select() { return this; }, lean: async () => [] };
  });
  t.mock.method(Event, "find", (query) => {
    eventQueries.push(query);
    return { select() { return this; }, sort() { return this; }, lean: async () => [] };
  });
  for (const region of ["breda_tilburg", "unassigned"]) {
    await getMembers({ query: { region }, regionScope: { member: null } }, response(), () => {});
    await getEventsAnalytics({ query: { region }, regionScope: { event: null } }, response(), () => {});
  }
  assert.deepEqual(memberQueries[0].region, { $in: ["breda_tilburg", "breda", "bread"] });
  assert.deepEqual(eventQueries[0].region, memberQueries[0].region);
  assert.equal(memberQueries[1].region.$nin.includes("breda_tilburg"), true);
  assert.equal(eventQueries[1].region.$nin.includes("breda"), true);
});

test("dashboard roles receive scoped member aggregates without identities", async (t) => {
  for (const role of ["active_member", "regional_committee_member", "support", "developer"]) {
    assert.equal(DASHBOARD_ACCESS.includes(role), true);
  }
  const filters = [];
  t.mock.method(MemberUser, "find", (query) => {
    filters.push(query);
    const regionalMembers = [{
      _id: "member_1", name: "Private", email: "private@example.com", roles: ["member"], status: "active",
      joinDate: new Date("2026-09-02T12:00:00Z"), expireDate: new Date("2099-09-02T12:00:00Z"),
      subscription: { id: "sub_private", period: 12 }, region: "groningen",
    }, {
      _id: "member_2", name: "Older", roles: ["member"], status: "active",
      joinDate: new Date("2024-09-02T12:00:00Z"), expireDate: new Date("2099-09-02T12:00:00Z"),
      subscription: { id: "sub_older", period: 12 }, region: "groningen",
    }, {
      _id: "member_3", name: "Expired", roles: ["member"], status: "active",
      joinDate: new Date("2024-09-02T12:00:00Z"), expireDate: new Date("2025-09-02T12:00:00Z"),
      subscription: { id: "sub_expired", period: 12 }, region: "groningen",
    }];
    const nationalMembers = [...regionalMembers, {
      _id: "member_4", email: "other@example.com", roles: ["member"], status: "active",
      joinDate: new Date("2026-09-03T12:00:00Z"), expireDate: new Date("2099-09-03T12:00:00Z"),
      region: "amsterdam",
    }];
    return { select() { return this; }, lean: async () => query.region ? regionalMembers : nationalMembers };
  });
  const res = response();
  let error;
  await getMemberStatistics({ query: { from: "2026-08-25", to: "2026-10-09" }, regionScope: { member: "groningen" } }, res, (value) => { error = value; });
  assert.equal(error, undefined);
  assert.deepEqual(filters[0], { region: "groningen" });
  assert.deepEqual(filters[1], { status: { $nin: ["alumni-migrated", "membership_active", "membership-migrated"] } });
  assert.equal(res.body.summary.totalActive, 2);
  assert.equal(res.body.summary.totalInactive, 1);
  assert.equal(res.body.summary.mmr, 1.66);
  assert.equal(res.body.monthly["2026-09"], 1);
  assert.equal(res.body.monthly["2024-09"], undefined);
  assert.deepEqual(res.body.activeMonthly, { "2026-08": 1, "2026-09": 2, "2026-10": 2 });
  assert.equal(res.body.region, "groningen");
  assert.equal(res.body.averages.monthCount, 3);
  assert.equal(res.body.averages.averageNewMembersMonth, 0.33);
  assert.equal(res.body.nationalAverages.averageNewMembersMonth, 0.67);
  assert.equal(JSON.stringify(res.body).includes("private@example.com"), false);
  assert.equal(JSON.stringify(res.body).includes("other@example.com"), false);
  assert.equal(JSON.stringify(res.body).includes("sub_private"), false);
});

test("national member statistics reuse the combined averages", async (t) => {
  let queries = 0;
  t.mock.method(MemberUser, "find", () => {
    queries++;
    return { select() { return this; }, lean: async () => [] };
  });
  const res = response();
  await getMemberStatistics({ query: { from: "2026-08-25", to: "2026-10-09" }, regionScope: { member: null } }, res, () => {});
  assert.equal(queries, 1);
  assert.equal(res.body.region, "national");
  assert.deepEqual(res.body.nationalAverages, res.body.averages);
});

test("members without a join date are not counted as new", async (t) => {
  t.mock.method(MemberUser, "find", () => ({ select() { return this; }, lean: async () => [{
    _id: "member_without_join_date", roles: ["member"], status: "active",
    expireDate: new Date("2099-09-03T12:00:00Z"), subscription: {}, region: "amsterdam",
  }] }));
  const res = response();
  await getMemberStatistics({ query: { from: "2026-08-25", to: "2026-10-13" }, regionScope: { member: null } }, res, () => {});
  assert.equal(res.body.summary.totalActive, 1);
  assert.deepEqual(res.body.monthly, {});
  assert.deepEqual(res.body.activeMonthly, { "2026-08": 0, "2026-09": 0, "2026-10": 0 });
});

test("event statistics omit ticket identities and respect region scope", async (t) => {
  const filters = [];
  t.mock.method(Event, "find", (query) => {
    filters.push(query);
    const regional = [{
      _id: "event_1", title: "Autumn social", date: new Date("2026-09-14T12:00:00Z"),
      region: "groningen", status: "opened", createdAt: new Date("2026-09-12T12:00:00Z"),
      ticketLimit: 40, isFree: false, product: { guest: { price: 10 }, member: { price: 5 } },
      guestList: [
        { _id: "ticket_private", type: "guest", name: "Private", email: "private@example.com", status: 0 },
        { _id: "ticket_member", type: "member", refunded: true, refundAmountCents: 200, status: 0 },
      ],
    }];
    const national = [...regional, {
      _id: "event_2", title: "Another social", date: new Date("2026-09-15T12:00:00Z"),
      region: "amsterdam", status: "archived", createdAt: new Date("2026-09-12T12:00:00Z"),
      product: { guest: { price: 10 } }, guestList: [{ type: "guest" }],
    }];
    return { select() { return this; }, sort() { return this; }, lean: async () =>
      query.$or && !query.region ? national : query.$or ? regional : [
        { _id: "event_1", title: "Autumn social", date: new Date("2026-09-14T12:00:00Z") },
        { _id: "event_older", title: "Older social", date: new Date("2025-05-14T12:00:00Z") },
      ] };
  });
  const res = response();
  let error;
  await getEventStatistics({ query: { from: "2026-08-25", to: "2026-10-09" }, regionScope: { event: "groningen" } }, res, (value) => { error = value; });
  assert.equal(error, undefined);
  assert.equal(filters.length, 3);
  assert.equal(filters[0].region, "groningen");
  assert.equal(filters[0].date, undefined);
  assert.equal(filters[1].region, "groningen");
  assert.equal(filters[1].status.$nin.includes("archived"), false);
  assert.equal(filters[2].region, undefined);
  assert.deepEqual(filters[2].status, filters[1].status);
  assert.deepEqual(res.body.eventOptions.map((event) => event._id), ["event_1", "event_older"]);
  assert.equal(res.body.events.length, 1);
  assert.equal(res.body.events[0].revenue, 13);
  assert.equal(res.body.events[0].ticketCount, 2);
  assert.equal(res.body.events[0].guestTickets, 1);
  assert.equal(res.body.events[0].memberTickets, 1);
  assert.equal(res.body.events[0].refunds, 2);
  assert.equal(res.body.events[0].totalGuests, 1);
  assert.equal(res.body.events[0].ticketLimit, 40);
  assert.equal(res.body.region, "groningen");
  assert.equal(res.body.averages.eventCount, 1);
  assert.equal(res.body.averages.averageEventPresence, 48);
  assert.equal(res.body.averages.averageEventTicketCount, 2);
  assert.equal(res.body.averages.averageEventTicketTypeRatio, 50);
  assert.equal(res.body.averages.averageEventRevenue, 13);
  assert.equal(res.body.averages.averageEventRefund, 2);
  assert.equal(res.body.nationalAverages.eventCount, 2);
  assert.equal(res.body.nationalAverages.averageEventPresence, 60);
  assert.equal(res.body.nationalAverages.averageEventTicketCount, 1.5);
  assert.equal(res.body.nationalAverages.averageEventTicketTypeRatio, 33.33);
  assert.equal(res.body.nationalAverages.averageEventRevenue, 11.5);
  assert.equal(res.body.nationalAverages.averageEventRefund, 1);
  assert.equal(JSON.stringify(res.body).includes("private@example.com"), false);
  assert.equal(JSON.stringify(res.body).includes("ticket_private"), false);
});

test("national event metrics reuse the pooled averages without a second event scan", async (t) => {
  let queries = 0;
  t.mock.method(Event, "find", () => {
    queries++;
    return { select() { return this; }, sort() { return this; }, lean: async () => [] };
  });
  const res = response();
  await getEventStatistics({ query: { from: "2026-08-25", to: "2026-10-09" }, regionScope: { event: null } }, res, () => {});
  assert.equal(queries, 2);
  assert.equal(res.body.region, "national");
  assert.deepEqual(res.body.nationalAverages, res.body.averages);
});
