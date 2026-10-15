import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEventCampaignService } from "../services/events/event-campaigns.js";
import { campaignAvailability, campaignCities, campaignDeliveryKey, campaignVersion, alreadyHasEventTicket, lastChanceDue } from "../services/events/event-campaign-policy.js";
import { buildEventCampaignEmail } from "../services/events/event-campaign-email.js";
import { createEventCampaignHandlers } from "../controllers/Events/event-campaign-controller.js";
import { academicYearStart, standardTicketSavingsCents } from "../services/events/guest-savings-campaign.js";
import { academicYearRange } from "../util/config/academic-year.js";
import { GUEST_SAVINGS_TEMPLATE, pastRegionalPosters, regionalPosterStart } from "../services/events/guest-savings-email.js";

const time = new Date("2026-10-01T12:00:00Z");
const id = "507f1f77bcf86cd799439011";
const eventFixture = () => ({ _id: id, region: "groningen", status: "opened", title: "Autumn event", location: "Groningen", date: new Date("2026-10-02T12:00:00Z"),
  ticketTimer: new Date("2026-10-02T11:00:00Z"), ticketLimit: 100, guestList: [], product: { guest: { price: 15 }, member: { price: 10 }, activeMember: { price: 8 }, promoCodes: [] } });
const valueAt = (row, key) => key.split(".").reduce((value, part) => Array.isArray(value) ? value.map(item => item?.[part]) : value?.[part], row);
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some(clause => matches(row, clause));
    if (key === "$expr") return value.$in[1].includes(row.email.trim().toLowerCase());
    const actual = valueAt(row, key);
    if (value === null) return actual == null;
    if (value && typeof value === "object" && !(value instanceof Date)) return Object.entries(value).every(([op, expected]) => {
      if (op === "$in") return expected.includes(actual);
      if (op === "$nin") return !expected.includes(actual);
      if (op === "$ne") return Array.isArray(actual) ? !actual.includes(expected) : actual !== expected;
      if (op === "$lt") return actual < expected;
      if (op === "$lte") return actual <= expected;
      if (op === "$gt") return actual > expected;
      if (op === "$gte") return actual >= expected;
      if (op === "$exists") return (actual !== undefined) === expected;
      throw new Error(`Unknown test operator ${op}`);
    });
    return String(actual) === String(value);
  });
}
function memoryModel(seed = []) {
  const rows = structuredClone(seed);
  const query = get => ({ select() { return this; }, limit() { return this; }, sort() { return this; }, lean() { return Promise.resolve(structuredClone(get())); }, then(resolve, reject) { return this.lean().then(resolve, reject); } });
  const update = (filter, changes, options = {}) => {
    let row = rows.find(row => matches(row, filter));
    if (!row && options.upsert) { row = { ...filter, ...structuredClone(changes.$setOnInsert || {}) }; rows.push(row); }
    if (!row) return null;
    Object.assign(row, structuredClone(changes.$set || {}));
    for (const [key, value] of Object.entries(changes.$push || {})) {
      const appended = value.$each || [value];
      row[key] = [...(row[key] || []), ...structuredClone(appended)];
      if (value.$slice < 0) row[key] = row[key].slice(value.$slice);
    }
    for (const [key, value] of Object.entries(changes.$inc || {})) row[key] = (row[key] || 0) + value;
    for (const key of Object.keys(changes.$unset || {})) delete row[key];
    return row;
  };
  return { rows, find: filter => query(() => rows.filter(row => matches(row, filter))), findById: id => query(() => rows.find(row => row._id === id)),
    findOne: filter => query(() => rows.find(row => matches(row, filter))), exists: async filter => rows.some(row => matches(row, filter)),
    findOneAndUpdate: (filter, changes, options) => { const row = update(filter, changes, options); return query(() => row); },
    updateOne: async (filter, changes, options) => update(filter, changes, options),
    updateMany: async (filter, changes) => { for (const row of rows.filter(row => matches(row, filter))) update({ _id: row._id }, changes); },
    aggregate: async stages => {
      const grouped = new Map();
      for (const row of rows.filter(row => matches(row, stages[0].$match))) grouped.set(row.status, (grouped.get(row.status) || 0) + 1);
      return [...grouped].map(([_id, count]) => ({ _id, count }));
    } };
}
function setup() {
  let current = new Date(time);
  const EventModel = memoryModel([eventFixture()]);
  const MemberModel = memoryModel([{ _id: "member_507f1f77bcf86cd799439012", email: " MEMBER@example.test ", name: "Member", status: "active", roles: ["member"], expireDate: new Date("2027-01-01"), accountAliases: ["old-member-id"] }]);
  const AlumniModel = memoryModel();
  const GuestModel = memoryModel();
  const marketing = (email, city = "groningen", extra = {}) => ({ email, city, unsubscribed: false, consent: { granted: true }, ...extra });
  const MarketingModel = memoryModel([marketing("member@example.test"), marketing("guest@example.test"), marketing("guest@example.test", "leeuwarden"),
    marketing("outside@example.test", "maastricht"), marketing("optout@example.test"), marketing("optout@example.test", "amsterdam", { unsubscribed: true }),
    marketing("no-consent@example.test", "groningen", { consent: { granted: false } })]);
  const CampaignModel = memoryModel(), DeliveryModel = memoryModel();
  const sends = [], signupLinks = [];
  const dependencies = { EventModel, MemberModel, AlumniModel, MarketingModel, GuestModel, CampaignModel, DeliveryModel, now: () => current,
    secret: () => "test-review-secret-32-characters-long", makeLink: () => "https://example.test/personal-ticket",
    makeSignupLink: details => { signupLinks.push(details); return "https://example.test/groningen/signup?prefill=g1.encrypted-signup"; },
    send: async (...args) => sends.push(args) };
  const service = createEventCampaignService(dependencies);
  const options = { kind: "announcement", audience: "both" };
  const confirm = async (overrides = {}) => { const selection = { ...options, ...overrides }; const preview = await service.preview(id, selection, "admin");
    return service.confirm(id, { ...selection, review: preview.review, requestId: randomUUID() }, "admin"); };
  return { ...dependencies, service, sends, signupLinks, confirm, options, event: EventModel.rows[0], setTime: date => { current = date; } };
}

test("regional audience is consented, globally opted-in, classified and deduplicated", async () => {
  const { service, options } = setup();
  const preview = await service.preview(id, options, "admin");
  assert.equal(preview.total, 2);
  assert.deepEqual(preview.counts, { members: 1, guests: 1 });
  assert.deepEqual(preview.regions, ["groningen", "leeuwarden"]);
  assert.equal(preview.previews.length, 2);
  assert.doesNotMatch(JSON.stringify(preview), /member@example|guest@example/);
  assert.ok(campaignCities({ region: "leiden_hague" }).includes("den haag"));
});

test("new event announcements add consenting guests from this academic year in the host and nearby regions", async () => {
  const state = setup();
  const row = (email, region, academicYear = "2026-2027") => ({ email, region, academicYear });
  state.GuestModel.rows.push(
    row("host@example.test", "groningen"), row("near@example.test", "leeuwarden"),
    row("near@example.test", "groningen"), row("guest@example.test", "leeuwarden"),
    row("old@example.test", "groningen", "2025-2026"), row("far@example.test", "maastricht"),
    row("no-consent@example.test", "groningen"), row("optout@example.test", "groningen"),
    row("registered@example.test", "groningen"), row("alumni@example.test", "groningen"),
  );
  for (const email of ["host", "near", "old", "far", "registered", "alumni"]) {
    state.MarketingModel.rows.push({ email: `${email}@example.test`, city: "maastricht", unsubscribed: false, consent: { granted: true } });
  }
  state.MemberModel.rows.push({ _id: "registered-member", email: "registered@example.test", status: "active", roles: ["member"], expireDate: new Date("2027-01-01") });
  state.AlumniModel.rows.push({ email: "alumni@example.test" });

  const preview = await state.service.preview(id, state.options, "admin");
  assert.deepEqual(preview.counts, { members: 1, guests: 3 });
  assert.deepEqual((await state.service.preview(id, { kind: "announcement", audience: "members" }, "admin")).counts,
    { members: 1, guests: 0 });
  assert.deepEqual((await state.service.preview(id, { kind: "last-chance", audience: "both" }, "admin")).counts,
    { members: 1, guests: 1 });

  const campaign = await state.confirm();
  await state.service.processCampaign(campaign);
  assert.deepEqual(state.sends.map(send => send[1]).sort(), ["guest@example.test", "host@example.test", "member@example.test", "near@example.test"]);
  const guestMessage = state.sends.find(send => send[1] === "guest@example.test")?.[2];
  assert.match(guestMessage.html, /\/groningen\/purchase-ticket\/507f1f77bcf86cd799439011/);
  assert.doesNotMatch(guestMessage.html, /Your ticket price/);
});

test("announcement worker rechecks guest records, registration and opt-outs before each send", async () => {
  const state = setup();
  for (const email of ["year", "registered", "revoke"]) {
    state.GuestModel.rows.push({ email: `${email}@example.test`, region: "leeuwarden", academicYear: "2026-2027" });
    state.MarketingModel.rows.push({ email: `${email}@example.test`, city: "maastricht", unsubscribed: false, consent: { granted: true } });
  }
  const campaign = await state.confirm();
  state.GuestModel.rows.splice(state.GuestModel.rows.findIndex(row => row.email === "year@example.test"), 1);
  state.MemberModel.rows.push({ _id: "new-member", email: "registered@example.test", status: "active", roles: ["member"], expireDate: new Date("2027-01-01") });
  state.MarketingModel.rows.push({ email: "revoke@example.test", city: "groningen", unsubscribed: true, consent: { granted: true } });
  await state.service.processCampaign(campaign);
  assert.deepEqual(state.sends.map(send => send[1]).sort(), ["guest@example.test", "member@example.test"]);
  assert.equal(state.event.mailHistory[0].skipped, 3);
});

test("announcement guest rows from a previous academic year are skipped after the reset date", async () => {
  const state = setup();
  state.setTime(new Date("2027-08-24T21:59:59Z"));
  state.event.date = new Date("2027-09-02T12:00:00Z");
  state.event.ticketTimer = new Date("2027-09-02T11:00:00Z");
  state.GuestModel.rows.push({ email: "year@example.test", region: "leeuwarden", academicYear: "2026-2027" });
  state.MarketingModel.rows.push({ email: "year@example.test", city: "maastricht", unsubscribed: false, consent: { granted: true } });
  const campaign = await state.confirm({ audience: "guests" });
  state.setTime(new Date("2027-08-24T22:00:01Z"));
  await state.service.processCampaign(campaign);
  assert.ok(!state.sends.some(send => send[1] === "year@example.test"));
  assert.ok(state.event.mailHistory[0].skipped >= 1);
});

test("publication queues the new event announcement for members and eligible guests", async () => {
  const state = setup();
  state.event.date = new Date("2026-10-10T12:00:00Z");
  state.event.ticketTimer = new Date("2026-10-10T11:00:00Z");
  state.event.memberAnnouncementQueuedAt = time;
  state.GuestModel.rows.push({ email: "near@example.test", region: "leeuwarden", academicYear: "2026-2027" });
  state.MarketingModel.rows.push({ email: "near@example.test", city: "maastricht", unsubscribed: false, consent: { granted: true } });
  await state.service.tick();
  assert.equal(state.CampaignModel.rows[0].audience, "both");
  assert.deepEqual(state.sends.map(send => send[1]).sort(), ["guest@example.test", "member@example.test", "near@example.test"]);
  assert.ok(state.event.memberAnnouncementCompletedAt);
});

test("guest savings waits three days, deduplicates guest emails and totals this academic year's standard price differences", async () => {
  const state = setup();
  state.event.poster = "https://res.cloudinary.com/bgsnl/image/upload/v1/current/poster.jpg";
  state.event.guestList.push(
    { email: " GUEST@example.test ", name: "Guest Person", phone: "+31612345678", type: "guest" },
    { email: "guest@example.test", name: "Guest Person", phone: "+31612345678", type: "guest" },
    { email: "member@example.test", name: "Member Person", type: "guest" },
    { email: "optout@example.test", name: "Opted Out", type: "guest" },
  );
  state.EventModel.rows.push({ _id: "507f1f77bcf86cd799439012", region: "groningen", status: "archived", title: "September event",
    date: new Date("2026-09-15T12:00:00Z"), poster: "https://res.cloudinary.com/bgsnl/image/upload/v1/archived-event-posters/previous.jpg", product: { guest: { price: 20 }, member: { price: 10 } },
    guestList: [{ email: "guest@example.test", type: "guest" }, { email: "guest@example.test", type: "member" }] });
  state.EventModel.rows.push(
    { _id: "507f1f77bcf86cd799439013", region: "groningen", status: "opened", title: "Before poster season",
      date: new Date("2026-08-25T21:59:59Z"), poster: "https://example.test/before.jpg" },
    { _id: "507f1f77bcf86cd799439014", region: "groningen", status: "opened", title: "Poster season opening",
      date: new Date("2026-08-25T22:00:00Z"), poster: "https://example.test/opening.jpg" },
  );
  const service = createEventCampaignService({ ...state, makeSavingsLink: () => "https://example.test/encrypted-signup" });
  await assert.rejects(service.preview(id, { kind: "guest-savings" }, "admin"), { statusCode: 409 });
  state.setTime(new Date("2026-10-05T13:00:00Z"));
  const preview = await service.preview(id, { kind: "guest-savings" }, "admin");
  assert.equal(preview.total, 1);
  assert.equal(preview.savingsTotalCents, 2000);
  assert.match(preview.previews[0].html, /Your potential ticket savings/);
  assert.match(preview.previews[0].html, /The tickets you could have kept/);
  assert.match(preview.previews[0].html, /current\/poster\.jpg/);
  assert.match(preview.previews[0].html, /archived-event-posters\/previous\.jpg/);
  assert.doesNotMatch(preview.previews[0].html, /opening\.jpg/);
  assert.doesNotMatch(preview.previews[0].html, /before\.jpg/);
  assert.doesNotMatch(JSON.stringify(preview), /guest@example\.test|Guest Person/);
  const campaign = await service.confirm(id, { kind: "guest-savings", review: preview.review, requestId: randomUUID() }, "admin");
  await service.tick();
  assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0][0], GUEST_SAVINGS_TEMPLATE);
  assert.match(state.sends[0][2].subject, /€\s?20/);
  assert.match(state.sends[0][2].signupUrl, /encrypted-signup/);
  assert.equal(state.sends[0][2].rows.length, 2);
  assert.equal(state.sends[0][2].posterRows[0].left.title, "Autumn event");
  assert.match(state.sends[0][2].posterRows[0].right.poster, /archived-event-posters\/previous\.jpg/);
  await service.tick();
  assert.equal(state.sends.length, 1);
  assert.equal(state.CampaignModel.rows.find(row => row._id === campaign._id).status, "completed");
  assert.equal(state.event.mailHistory[0].kind, "guest-savings");
  assert.equal(state.event.mailHistory[0].accepted, 1);
  assert.equal((await service.preview(id, { kind: "guest-savings" }, "admin")).total, 0);
});

test("guest savings poster gallery includes past visible events in the region and skips deleted archive images", () => {
  const now = new Date("2026-10-05T13:00:00Z");
  const image = name => `https://res.cloudinary.com/bgsnl/image/upload/v1/${name}/poster.jpg`;
  const base = { region: "groningen", status: "opened", title: "Past event", date: new Date("2026-10-01T12:00:00Z"), poster: image("past") };
  const posters = pastRegionalPosters([
    base,
    { ...base, title: "Before season", date: new Date("2026-08-25T21:59:59Z"), poster: image("before-season") },
    { ...base, title: "Season opening", date: new Date("2026-08-25T22:00:00Z"), poster: image("season-opening") },
    { ...base, title: "Other region", region: "amsterdam", poster: image("other") },
    { ...base, title: "Future event", correctedDate: new Date("2026-10-06T12:00:00Z"), poster: image("future") },
    { ...base, title: "Hidden event", hidden: true, poster: image("hidden") },
    { ...base, title: "Unsafe image", poster: "javascript:alert(1)" },
    { ...base, title: "Deleted archive", status: "archived", folder: "old-event", archiveCleanupCompletedAt: now, poster: image("old-event") },
    { ...base, title: "Retained archive", status: "archived", folder: "retained-event", archiveCleanupCompletedAt: now, mediaRetainedAt: now, poster: image("retained-event") },
    { ...base, title: "Cleaned archive", status: "archived", folder: "cleaned-event", mediaRetainedAt: now, mediaCleanupAt: now, poster: image("cleaned-event") },
    { ...base, title: "Preserved archive", status: "archived", folder: "old-event", archiveCleanupCompletedAt: now, poster: image("archived-event-posters") },
  ], "groningen", now);
  assert.deepEqual(posters.map(item => item.title), ["Past event", "Retained archive", "Preserved archive", "Season opening"]);
});

test("regional poster season changes on 26 August at Amsterdam midnight", () => {
  assert.equal(regionalPosterStart(new Date("2026-08-25T21:59:59Z")).toISOString(), "2025-08-25T22:00:00.000Z");
  assert.equal(regionalPosterStart(new Date("2026-08-25T22:00:00Z")).toISOString(), "2026-08-25T22:00:00.000Z");
  assert.equal(regionalPosterStart(new Date("2027-02-01T12:00:00Z")).toISOString(), "2026-08-25T22:00:00.000Z");
});

test("guest savings rechecks opt-outs after approval and never sends a revoked address", async () => {
  const state = setup();
  state.event.guestList.push({ email: "guest@example.test", name: "Guest Person", type: "guest" });
  state.setTime(new Date("2026-10-05T13:00:00Z"));
  const service = createEventCampaignService({ ...state, makeSavingsLink: () => "https://example.test/encrypted-signup" });
  const preview = await service.preview(id, { kind: "guest-savings" }, "admin");
  const campaign = await service.confirm(id, { kind: "guest-savings", review: preview.review, requestId: randomUUID() }, "admin");
  state.MarketingModel.rows.find(row => row.email === "guest@example.test").unsubscribed = true;
  await service.processCampaign(campaign);
  assert.equal(state.sends.length, 0);
  assert.equal(state.CampaignModel.rows[0].skipped, 1);
});

test("guest savings skips an address when reviewed ticket prices change before delivery", async () => {
  const state = setup();
  state.event.guestList.push({ email: "guest@example.test", name: "Guest Person", type: "guest" });
  state.setTime(new Date("2026-10-05T13:00:00Z"));
  const service = createEventCampaignService({ ...state, makeSavingsLink: () => "https://example.test/encrypted-signup" });
  const preview = await service.preview(id, { kind: "guest-savings" }, "admin");
  const campaign = await service.confirm(id, { kind: "guest-savings", review: preview.review, requestId: randomUUID() }, "admin");
  state.event.product.guest.price = 25;
  await service.processCampaign(campaign);
  assert.equal(state.sends.length, 0);
  assert.equal(state.CampaignModel.rows[0].skipped, 1);
});

test("guest savings skips an address when a purchased event poster changes after review", async () => {
  const state = setup();
  state.event.poster = "https://res.cloudinary.com/bgsnl/image/upload/v1/current/poster.jpg";
  state.event.guestList.push({ email: "guest@example.test", name: "Guest Person", type: "guest" });
  state.setTime(new Date("2026-10-05T13:00:00Z"));
  const service = createEventCampaignService({ ...state, makeSavingsLink: () => "https://example.test/encrypted-signup" });
  const preview = await service.preview(id, { kind: "guest-savings" }, "admin");
  const campaign = await service.confirm(id, { kind: "guest-savings", review: preview.review, requestId: randomUUID() }, "admin");
  state.event.poster = "https://res.cloudinary.com/bgsnl/image/upload/v2/current/poster.jpg";
  await service.processCampaign(campaign);
  assert.equal(state.sends.length, 0);
  assert.equal(state.CampaignModel.rows[0].skipped, 1);
});

test("academic years run from 25 August to the next 25 August in Amsterdam", () => {
  assert.equal(academicYearStart(new Date("2026-08-24T21:59:59Z")).toISOString(), "2025-08-24T22:00:00.000Z");
  assert.equal(academicYearStart(new Date("2026-08-24T22:00:00Z")).toISOString(), "2026-08-24T22:00:00.000Z");
  assert.deepEqual(Object.fromEntries(Object.entries(academicYearRange(new Date("2026-10-05T12:00:00Z")))
    .map(([key, date]) => [key, date.toISOString()])), {
    start: "2026-08-24T22:00:00.000Z", end: "2027-08-24T22:00:00.000Z",
  });
});
test("guest savings includes 25 August tickets and excludes the preceding academic year", async () => {
  const state = setup();
  const guest = { email: "guest@example.test", type: "guest" };
  state.event.guestList.push(guest);
  state.EventModel.rows.push(
    { _id: "507f1f77bcf86cd799439020", region: "groningen", status: "archived", title: "Previous academic year",
      date: new Date("2026-08-24T21:59:59Z"), product: { guest: { price: 20 }, member: { price: 10 } }, guestList: [guest] },
    { _id: "507f1f77bcf86cd799439021", region: "groningen", status: "archived", title: "New academic year",
      date: new Date("2026-08-24T22:00:00Z"), product: { guest: { price: 20 }, member: { price: 10 } }, guestList: [guest] },
  );
  state.setTime(new Date("2026-10-05T13:00:00Z"));
  const service = createEventCampaignService(state);
  const preview = await service.preview(id, { kind: "guest-savings" }, "admin");
  assert.equal(preview.savingsTotalCents, 1500);
  assert.match(preview.previews[0].html, /New academic year/);
  assert.doesNotMatch(preview.previews[0].html, /Previous academic year/);
});
test("unknown ticket prices do not invent savings", () => {
  assert.equal(standardTicketSavingsCents({ product: { guest: { price: 15 }, member: { price: 9.5 } } }), 550);
  assert.equal(standardTicketSavingsCents({ product: { guest: { price: 15 } } }), 0);
});
test("buyers are excluded by normalized email or historical account alias, including refunded tickets", async () => {
  const { service, event, options } = setup();
  event.guestList.push({ email: " GUEST@EXAMPLE.TEST ", refunded: true }, { userId: "old-member-id", email: "changed@example.test" });
  assert.equal((await service.preview(id, options, "admin")).total, 0);
  assert.equal(alreadyHasEventTicket(event, { email: "guest@example.test" }), true);
});
test("member-only campaigns cannot include guests; expired members get guest classification", async () => {
  const { service, event, MemberModel, options } = setup();
  event.memberOnly = true;
  assert.equal((await service.preview(id, options, "admin")).total, 1);
  MemberModel.rows[0].expireDate = new Date("2025-01-01");
  assert.equal((await service.preview(id, options, "admin")).total, 0);
});
test("closed, full, external, past and unknown-region events block; 90% capacity warns", () => {
  for (const patch of [{ isSaleClosed: true }, { ticketLimit: 0 }, { status: "canceled" }, { date: time }, { ticketLink: "https://tickets.test" }, { region: "unknown" }]) {
    assert.equal(campaignAvailability({ ...eventFixture(), ...patch }, time).blocked, true);
  }
  const nearlyFull = campaignAvailability({ ...eventFixture(), guestList: Array(90).fill({}) }, time);
  assert.equal(nearlyFull.blocked, false); assert.match(nearlyFull.warnings[0], /nearly sold out/);
});
test("last chance runs at 24h, follows corrected date, and catches up for one hour only", () => {
  assert.equal(lastChanceDue(eventFixture(), time), true);
  assert.equal(lastChanceDue(eventFixture(), new Date(time.getTime() - 1)), false);
  assert.equal(lastChanceDue(eventFixture(), new Date(time.getTime() + 3600000)), false);
  assert.equal(lastChanceDue({ ...eventFixture(), correctedDate: new Date("2026-10-04") }, time), false);
  assert.equal(lastChanceDue({ ...eventFixture(), isSaleClosed: true }, time), false);
});
test("confirmation is bound to actor, live audience, event contents and review expiry", async () => {
  const { service, options, event, setTime } = setup();
  const preview = await service.preview(id, options, "admin");
  const input = { ...options, review: preview.review, requestId: randomUUID() };
  await assert.rejects(service.confirm(id, input, "other-admin"), { statusCode: 409 });
  event.title = "New title";
  await assert.rejects(service.confirm(id, input, "admin"), { statusCode: 409 });
  event.title = "Autumn event";
  setTime(new Date(time.getTime() + 11 * 60000));
  await assert.rejects(service.confirm(id, input, "admin"), { statusCode: 409 });
});
test("lost confirm response replays the same request, not a second campaign", async () => {
  const { service, options, CampaignModel } = setup();
  const preview = await service.preview(id, options, "admin");
  const input = { ...options, review: preview.review, requestId: randomUUID() };
  const first = await service.confirm(id, input, "admin"), second = await service.confirm(id, input, "admin");
  assert.equal(first._id, second._id); assert.equal(CampaignModel.rows.length, 1);
});
test("worker sends members and guests as bulk using durable IDs; restarts do not resend", async () => {
  const state = setup(); const campaign = await state.confirm();
  await state.service.processCampaign(campaign);
  assert.equal(state.sends.length, 2);
  assert.equal(state.sends[0][3].bulk.batchId, campaign._id);
  assert.match(state.sends[0][3].operationId, /^[a-f\d-]{36}$/);
  assert.match(state.sends.find(send => send[1] === "member@example.test")[2].html, /personal-ticket/);
  assert.match(state.sends.find(send => send[1] === "guest@example.test")[2].html, /\/groningen\/purchase-ticket\/507f1f77bcf86cd799439011/);
  await createEventCampaignService(state).processCampaign(campaign);
  assert.equal(state.sends.length, 2);
  assert.equal(state.event.mailHistory.length, 1);
  assert.equal(state.event.mailAcceptedTotal, 2);
  assert.deepEqual({ campaignId: state.event.mailHistory[0].campaignId, accepted: state.event.mailHistory[0].accepted,
    skipped: state.event.mailHistory[0].skipped, failed: state.event.mailHistory[0].failed },
  { campaignId: campaign._id, accepted: 2, skipped: 0, failed: 0 });
  assert.equal((await state.service.preview(id, state.options, "admin")).total, 0);
});
test("history write failure keeps the campaign retryable without resending accepted emails", async () => {
  const state = setup(), campaign = await state.confirm();
  const updateOne = state.EventModel.updateOne;
  let fail = true;
  state.EventModel.updateOne = async (...args) => {
    if (fail && args[1].$push?.mailHistory) { fail = false; throw new Error("Temporary database error"); }
    return updateOne(...args);
  };
  await assert.rejects(state.service.processCampaign(campaign), /Temporary database error/);
  assert.equal(state.CampaignModel.rows[0].status, "sending");
  await state.service.processCampaign(campaign);
  assert.equal(state.sends.length, 2);
  assert.equal(state.event.mailHistory.length, 1);
  assert.equal(state.event.mailHistory[0].accepted, 2);
});
test("audience overlap and concurrent workers cannot send the same campaign twice", async () => {
  const state = setup();
  const both = await state.confirm();
  await assert.rejects(state.confirm({ audience: "members" }), { statusCode: 409 });
  await Promise.all([state.service.processCampaign(both), state.service.processCampaign(both)]);
  assert.equal(state.sends.length, 2);
  assert.equal(new Set(state.sends.map(send => send[1])).size, 2);
});
test("worker rechecks new ticket purchases and unsubscribes after confirmation", async () => {
  const state = setup(), campaign = await state.confirm();
  state.event.guestList.push({ email: "guest@example.test" });
  state.MarketingModel.rows[0].unsubscribed = true;
  await state.service.processCampaign(campaign);
  assert.equal(state.sends.length, 0);
  assert.equal(state.event.mailHistory[0].skipped, 2);
});
test("sales closing or event content changing after review stops a queued campaign", async () => {
  for (const change of [event => { event.isSaleClosed = true; }, event => { event.product.guest.price = 20; }]) {
    const state = setup(), campaign = await state.confirm(); change(state.event);
    await state.service.processCampaign(campaign);
    assert.equal(state.sends.length, 0); assert.equal(state.CampaignModel.rows[0].status, "stopped");
    assert.equal(state.event.mailHistory[0].notSent, 2);
  }
});
test("delivery retries keep the exact payload and operation ID and stop after three retries", async () => {
  const state = setup(), campaign = await state.confirm({ audience: "members" }), calls = [];
  const service = createEventCampaignService({ ...state, send: async (...args) => { calls.push(args); throw new Error("Timeout"); } });
  for (let attempt = 0; attempt < 5; attempt++) { state.setTime(new Date(time.getTime() + attempt * 4 * 60000)); await service.processCampaign(campaign); }
  assert.equal(calls.length, 4);
  assert.equal(calls.every(call => JSON.stringify(call) === JSON.stringify(calls[0])), true);
  assert.equal(state.CampaignModel.rows[0].status, "completed-with-errors");
  assert.equal(state.CampaignModel.rows[0].failed, 1);
});
test("manual and automatic last-chance mail share deduplication keys", async () => {
  const state = setup(); const manual = await state.confirm({ kind: "last-chance" });
  await state.service.processCampaign(manual);
  assert.equal(await state.service.queueAutomatic(state.event), null);
  assert.equal(state.sends.length, 2);
});
test("legacy publication marker prevents member announcement repeats but not guest campaigns", async () => {
  const state = setup(); state.event.memberAnnouncementCompletedAt = time;
  const result = await state.service.preview(id, state.options, "admin");
  assert.deepEqual(result.counts, { members: 0, guests: 1 });
});
test("offers change deduplication versions, while ordinary announcements stay stable", () => {
  const event = eventFixture(), before = campaignVersion(event, "limited-offer", { now: time });
  event.product.guest.price = 12;
  assert.notEqual(campaignVersion(event, "limited-offer", { now: time }), before);
  assert.equal(campaignVersion(event, "announcement"), "1");
  assert.equal(campaignDeliveryKey(id, "announcement", "1", " A@B.TEST "), campaignDeliveryKey(id, "announcement", "1", "a@b.test"));
});
test("emails escape content and only show audience-eligible promo codes", () => {
  const event = eventFixture(); event.title = '<script>alert("x")</script>'; event.location = "<img onerror=x>";
  event.product.promoCodes = [{ code: "GUEST10", active: true, discountType: 2, discount: 10, audiences: ["guest"] }];
  const member = buildEventCampaignEmail({ event, recipient: { audience: "members" }, kind: "limited-offer", promoCode: "GUEST10", now: time });
  assert.doesNotMatch(member.html, /<script|<img onerror|GUEST10/);
  assert.doesNotMatch(member.html, /onerror=x/);
  const guest = buildEventCampaignEmail({ event, recipient: { audience: "guests" }, kind: "limited-offer", promoCode: "GUEST10", now: time });
  assert.match(guest.html, /GUEST10/); assert.match(guest.html, /10%/);
});
test("guest announcement matches the member event panel and links directly to guest purchase", () => {
  const event = eventFixture();
  event.poster = "https://example.org/poster.jpg";
  event.description = "Description omitted from the compact announcement";
  const email = buildEventCampaignEmail({ event, recipient: { audience: "guests" }, kind: "announcement", now: time });
  assert.equal(email.subject, `New event: ${event.title}`);
  assert.match(email.html, /Hi there, there is new event nearby/);
  assert.match(email.html, /class="bgsnl-event-preview"/);
  assert.match(email.html, />Groningen<\/span>/);
  assert.match(email.html, /src="https:\/\/example\.org\/poster\.jpg"/);
  assert.ok(email.html.indexOf(event.title) < email.html.indexOf("poster.jpg"));
  assert.match(email.html, /\/groningen\/purchase-ticket\/507f1f77bcf86cd799439011/);
  assert.match(email.html, /View event/);
  assert.match(email.html, /Get ticket/);
  assert.doesNotMatch(email.html, /Your ticket price|Become a member|Description omitted/);
  assert.doesNotMatch(email.text, /Your ticket price|Become a member|Description omitted/);
});
test("last-chance campaign uses a red timer heading without repeating the event name", () => {
  const event = eventFixture(); event.description = "Details available on the website";
  const email = buildEventCampaignEmail({ event, recipient: { audience: "members" }, kind: "last-chance", now: time });
  assert.equal(email.subject, "Last chance to book");
  assert.match(email.html, /timer-red\.png/);
  assert.match(email.html, /<table[^>]*align="center"/);
  assert.match(email.html, /<h1[^>]*color:#b42318[^>]*>Last chance to book<\/h1>/);
  assert.doesNotMatch(email.html, /Last chance to book:/);
  assert.doesNotMatch(email.html, /Hi there,/);
  const actions = email.html.match(/<table class="bgsnl-event-actions"[\s\S]*?<\/table>/)?.[0];
  assert.ok(actions);
  assert.equal((actions.match(/<tr>/g) || []).length, 1);
  assert.match(actions, /<a[^>]*>View event<\/a>[\s\S]*<a[^>]*>Get your ticket<\/a>/);
  assert.doesNotMatch(email.html, /Read more/);
  assert.match(email.html, />Groningen<\/span>/);
  assert.doesNotMatch(email.html, /Details available on the website|<p>Groningen<\/p>|Prices and availability/);
  assert.match(email.html, new RegExp(event.title));
  assert.match(email.text, /^Last chance to book\n\n/);
});
test("limited-offer guest email centers its icon and links to prefilled membership", () => {
  const signupUrl = "https://example.test/groningen/signup?prefill=g1.encrypted-signup";
  const event = eventFixture();
  event.description = "Details available on the website";
  event.promotion = { guest: { isEnabled: true, discount: 20 } };
  const email = buildEventCampaignEmail({ event, recipient: { audience: "guests" },
    kind: "limited-offer", signupUrl, now: time });
  assert.match(email.html, /<table[^>]*align="center"[^>]*>.*discount\.png/s);
  assert.match(email.html, /class="bgsnl-member-warning"/);
  assert.match(email.html, /user-star\.png/);
  assert.match(email.html, />Groningen<\/span>/);
  const actions = email.html.match(/<table class="bgsnl-event-actions"[\s\S]*?<\/table>/)?.[0];
  assert.ok(actions);
  assert.equal((actions.match(/<tr>/g) || []).length, 1);
  assert.match(actions, /<a[^>]*>View event<\/a>[\s\S]*<a[^>]*>Get your ticket<\/a>/);
  assert.doesNotMatch(email.html, /Read more/);
  assert.match(email.html, /<td[^>]*><a href="https:\/\/example\.test\/groningen\/signup\?prefill=g1\.encrypted-signup"[^>]*>Become a member<\/a> for member ticket prices/);
  assert.match(email.html, /Your ticket price: <strong>[^<]+<\/strong> <del[^>]*>[^<]+<\/del>/);
  assert.match(email.text, /normal price/);
  assert.doesNotMatch(email.html, /Details available on the website|<p>Groningen<\/p>|% off your ticket is included|Prices and availability/);
  assert.doesNotMatch(email.html, /Hi there,/);
  assert.doesNotMatch(email.text, /Hi there,/);
});
test("last-chance delivery generates a recipient-specific signup link", async () => {
  const state = setup();
  const campaign = await state.confirm({ kind: "last-chance", audience: "guests" });
  await state.service.processCampaign(campaign);
  assert.deepEqual(state.signupLinks, [{ email: "guest@example.test", region: "groningen", name: "", surname: "", phone: "" }]);
  assert.match(state.sends[0][2].html, /signup\?prefill=g1\.encrypted-signup/);
});
test("regional staff cannot access another region's campaign; national staff can preview", async () => {
  const state = setup(); const handlers = createEventCampaignHandlers({ ...state, enabled: () => false });
  let error, result;
  const request = { params: { eventId: id }, body: state.options, user: { userId: "admin", roles: ["regional_board_member"], region: "amsterdam" } };
  const response = { set() {}, json(value) { result = value; } };
  await handlers.preview(request, response, value => { error = value; });
  assert.equal(error.statusCode, 403);
  request.user.roles = ["admin"];
  await handlers.preview(request, response, value => { throw value; });
  assert.equal(result.preview.total, 2); assert.equal(result.sendingEnabled, false);
});
test("email history is scoped to the event and its permitted region", async () => {
  const state = setup();
  const campaign = await state.confirm();
  const handlers = createEventCampaignHandlers(state);
  let error, result;
  const request = { params: { eventId: id }, user: { userId: "admin", roles: ["regional_board_member"], region: "amsterdam" } };
  const response = { set() {}, json(value) { result = value; } };
  await handlers.history(request, response, value => { error = value; });
  assert.equal(error.statusCode, 403);
  request.user.roles = ["admin"];
  await handlers.history(request, response, value => { throw value; });
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].status, "queued");
  await state.service.processCampaign(campaign);
  await handlers.history(request, response, value => { throw value; });
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].accepted, 2);
  assert.equal(result.sentCount, 2);
  assert.equal(result.history[0].source, "manual");
  assert.equal(result.history[0].createdBy, undefined);
  assert.doesNotMatch(JSON.stringify(result.history), /member@example|guest@example/);
  state.CampaignModel.rows[0].status = "sending";
  await handlers.history(request, response, value => { throw value; });
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].status, "completed");
});

test("email history count includes older campaigns beyond the visible list and stays idempotent", async () => {
  const state = setup();
  const campaign = await state.confirm();
  state.event.mailHistory = Array.from({ length: 100 }, (_, index) => ({
    campaignId: `earlier-${index}`, kind: "limited-offer", audience: "guests", status: "completed",
    accepted: 2, createdAt: new Date(time.getTime() - (101 - index) * 60000), completedAt: time,
  }));
  const handlers = createEventCampaignHandlers(state);
  const request = { params: { eventId: id }, user: { userId: "admin", roles: ["admin"] } };
  let result;
  const response = { set() {}, json(value) { result = value; } };
  await handlers.history(request, response, error => { throw error; });
  assert.equal(result.history.length, 20);
  assert.equal(result.sentCount, 200);

  state.event.mailAcceptedTotal = 0; // Legacy records can acquire a schema default before the counter is initialized.
  await state.service.processCampaign(campaign);
  await state.service.processCampaign(campaign);
  assert.equal(state.event.mailHistory.length, 100);
  assert.equal(state.event.mailAcceptedTotal, 202);
  await handlers.history(request, response, error => { throw error; });
  assert.equal(result.history.length, 20);
  assert.equal(result.sentCount, 202);
});
