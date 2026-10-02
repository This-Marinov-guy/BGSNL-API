import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEventCampaignService } from "../services/events/event-campaigns.js";
import { campaignAvailability, campaignCities, campaignDeliveryKey, campaignVersion, alreadyHasEventTicket, lastChanceDue } from "../services/events/event-campaign-policy.js";
import { buildEventCampaignEmail } from "../services/events/event-campaign-email.js";
import { createEventCampaignHandlers } from "../controllers/Events/event-campaign-controller.js";

const time = new Date("2026-10-01T12:00:00Z");
const id = "507f1f77bcf86cd799439011";
const eventFixture = () => ({ _id: id, region: "groningen", status: "opened", title: "Autumn event", location: "Groningen", date: new Date("2026-10-02T12:00:00Z"),
  ticketTimer: new Date("2026-10-02T11:00:00Z"), ticketLimit: 100, guestList: [], product: { guest: { price: 15 }, member: { price: 10 }, activeMember: { price: 8 }, promoCodes: [] } });
const valueAt = (row, key) => key.split(".").reduce((value, part) => value?.[part], row);
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some(clause => matches(row, clause));
    if (key === "$expr") return value.$in[1].includes(row.email.trim().toLowerCase());
    const actual = valueAt(row, key);
    if (value === null) return actual == null;
    if (value && typeof value === "object" && !(value instanceof Date)) return Object.entries(value).every(([op, expected]) => {
      if (op === "$in") return expected.includes(actual);
      if (op === "$ne") return actual !== expected;
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
    for (const [key, value] of Object.entries(changes.$inc || {})) row[key] = (row[key] || 0) + value;
    for (const key of Object.keys(changes.$unset || {})) delete row[key];
    return row;
  };
  return { rows, find: filter => query(() => rows.filter(row => matches(row, filter))), findById: id => query(() => rows.find(row => row._id === id)),
    findOne: filter => query(() => rows.find(row => matches(row, filter))), exists: async filter => rows.some(row => matches(row, filter)),
    findOneAndUpdate: (filter, changes, options) => { const row = update(filter, changes, options); return query(() => row); },
    updateOne: async (filter, changes, options) => update(filter, changes, options),
    updateMany: async (filter, changes) => { for (const row of rows.filter(row => matches(row, filter))) update({ _id: row._id }, changes); } };
}
function setup() {
  let current = new Date(time);
  const EventModel = memoryModel([eventFixture()]);
  const MemberModel = memoryModel([{ _id: "member_507f1f77bcf86cd799439012", email: " MEMBER@example.test ", name: "Member", status: "active", roles: ["member"], expireDate: new Date("2027-01-01"), accountAliases: ["old-member-id"] }]);
  const marketing = (email, city = "groningen", extra = {}) => ({ email, city, unsubscribed: false, consent: { granted: true }, ...extra });
  const MarketingModel = memoryModel([marketing("member@example.test"), marketing("guest@example.test"), marketing("guest@example.test", "leeuwarden"),
    marketing("outside@example.test", "maastricht"), marketing("optout@example.test"), marketing("optout@example.test", "amsterdam", { unsubscribed: true }),
    marketing("no-consent@example.test", "groningen", { consent: { granted: false } })]);
  const CampaignModel = memoryModel(), DeliveryModel = memoryModel();
  const sends = [];
  const dependencies = { EventModel, MemberModel, MarketingModel, CampaignModel, DeliveryModel, now: () => current,
    secret: () => "test-review-secret-32-characters-long", makeLink: () => "https://example.test/personal-ticket", send: async (...args) => sends.push(args) };
  const service = createEventCampaignService(dependencies);
  const options = { kind: "announcement", audience: "both" };
  const confirm = async (overrides = {}) => { const selection = { ...options, ...overrides }; const preview = await service.preview(id, selection, "admin");
    return service.confirm(id, { ...selection, review: preview.review, requestId: randomUUID() }, "admin"); };
  return { ...dependencies, service, sends, confirm, options, event: EventModel.rows[0], setTime: date => { current = date; } };
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
  assert.match(state.sends.find(send => send[1] === "guest@example.test")[2].html, /Become a member/);
  await createEventCampaignService(state).processCampaign(campaign);
  assert.equal(state.sends.length, 2);
  assert.equal((await state.service.preview(id, state.options, "admin")).total, 0);
});
test("audience overlap and concurrent workers cannot send the same campaign twice", async () => {
  const state = setup();
  const both = await state.confirm(); const members = await state.confirm({ audience: "members" });
  await Promise.all([state.service.processCampaign(both), state.service.processCampaign(members)]);
  assert.equal(state.sends.length, 2);
  assert.equal(new Set(state.sends.map(send => send[1])).size, 2);
});
test("worker rechecks new ticket purchases and unsubscribes after confirmation", async () => {
  const state = setup(), campaign = await state.confirm();
  state.event.guestList.push({ email: "guest@example.test" });
  state.MarketingModel.rows[0].unsubscribed = true;
  await state.service.processCampaign(campaign);
  assert.equal(state.sends.length, 0);
  assert.equal(state.DeliveryModel.rows.every(row => row.status === "skipped"), true);
});
test("sales closing or event content changing after review stops a queued campaign", async () => {
  for (const change of [event => { event.isSaleClosed = true; }, event => { event.product.guest.price = 20; }]) {
    const state = setup(), campaign = await state.confirm(); change(state.event);
    await state.service.processCampaign(campaign);
    assert.equal(state.sends.length, 0); assert.equal(state.CampaignModel.rows[0].status, "stopped");
  }
});
test("delivery retries keep the exact payload and operation ID and stop after three retries", async () => {
  const state = setup(), campaign = await state.confirm({ audience: "members" }), calls = [];
  const service = createEventCampaignService({ ...state, send: async (...args) => { calls.push(args); throw new Error("Timeout"); } });
  for (let attempt = 0; attempt < 5; attempt++) { state.setTime(new Date(time.getTime() + attempt * 4 * 60000)); await service.processCampaign(campaign); }
  assert.equal(calls.length, 4);
  assert.equal(calls.every(call => JSON.stringify(call) === JSON.stringify(calls[0])), true);
  assert.equal(state.DeliveryModel.rows[0].status, "failed");
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
  assert.doesNotMatch(member.html, /<script|<img|GUEST10/);
  const guest = buildEventCampaignEmail({ event, recipient: { audience: "guests" }, kind: "limited-offer", promoCode: "GUEST10", now: time });
  assert.match(guest.html, /GUEST10/); assert.match(guest.html, /10%/);
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
