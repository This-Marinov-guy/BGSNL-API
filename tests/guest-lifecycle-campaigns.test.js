import assert from "node:assert/strict";
import test from "node:test";
import { dueGuestTermCampaigns, firstPaidGuestEvents, guestSavingsByEmail,
  runDueFirstPaidGuestEventCampaigns, runDueGuestTermCampaigns, sendFirstPaidGuestEvent, sendGuestTermRecap,
  startFirstPaidGuestEventCampaignWorker, startGuestTermCampaignWorker } from "../services/events/guest-lifecycle-campaigns.js";
import { isGuestMarketingRecipient } from "../services/events/guest-marketing-emails.js";
import { GUEST_SAVINGS_TEMPLATE } from "../services/events/guest-savings-email.js";

const event = { _id: "507f1f77bcf86cd799439011", title: "Winter Gala", region: "groningen",
  date: new Date("2027-02-01T18:00:00Z"), status: "published", poster: "https://example.com/gala.png",
  product: { guest: { price: 20 }, member: { price: 10 } },
  guestList: [
    { email: " GUEST@example.test ", name: "Ada Guest", phone: "1234567890", type: "guest" },
    { email: "guest@example.test", name: "Ada Guest", phone: "1234567890", type: "guest" },
    { email: "guest@example.test", name: "Ada Guest", type: "guest", refunded: true },
  ] };
const query = rows => ({ select() { return this; }, limit() { return this; }, lean: async () => rows });

test("term recaps become due at the end of 15 February and 15 May in Amsterdam", () => {
  assert.deepEqual(dueGuestTermCampaigns(new Date("2027-02-15T22:59:59.998Z")), []);
  assert.deepEqual(dueGuestTermCampaigns(new Date("2027-02-15T23:00:00Z")).map(row => [row.term, row.academicYear]),
    [["term2", "2026-2027"]]);
  assert.deepEqual(dueGuestTermCampaigns(new Date("2027-05-15T22:00:00Z")).map(row => [row.term, row.academicYear]),
    [["term3", "2026-2027"]]);
  assert.deepEqual(dueGuestTermCampaigns(new Date("2027-03-02T00:00:00Z")), []);
});

test("first paid guest event starts on 25 August and waits until the event has passed", () => {
  const base = { ...event, date: new Date("2026-08-26T18:00:00Z") };
  const earlier = { ...base, _id: "earlier", date: new Date("2026-08-24T18:00:00Z") };
  const later = { ...base, _id: "later", date: new Date("2026-09-01T18:00:00Z") };
  const free = { ...base, _id: "free", date: new Date("2026-08-25T18:00:00Z"), isFree: true };
  const freeTicket = { ...base, _id: "free-ticket", date: new Date("2026-08-25T19:00:00Z"),
    guestList: [{ ...event.guestList[0], type: "free guest" }] };
  const otherRegion = { ...base, _id: "amsterdam", region: "amsterdam" };
  const first = firstPaidGuestEvents([later, free, freeTicket, otherRegion, earlier, base], {
    start: new Date("2026-08-24T22:00:00Z"), now: new Date("2026-08-28T18:00:00Z"),
  });
  assert.equal(first.get("groningen"), base);
  assert.equal(first.get("amsterdam"), otherRegion);
  assert.equal(first.size, 2);
  assert.equal(firstPaidGuestEvents([base], { start: new Date("2026-08-24T22:00:00Z"),
    now: new Date("2026-08-27T17:59:59Z") }).size, 0);
});

test("first paid event emails consenting ticket holders once per region and year without posters", async () => {
  const sent = [];
  const options = { audience: async () => [{ email: "guest@example.test" }],
    eligible: async () => true, makeLink: () => "https://example.com/signup",
    send: async (...args) => sent.push(args) };
  assert.deepEqual(await sendFirstPaidGuestEvent(event, "2026-2027", options), { sent: 1, skipped: 0 });
  assert.equal(sent[0][0], GUEST_SAVINGS_TEMPLATE);
  assert.equal(sent[0][2].total, "€20.00");
  assert.match(sent[0][2].subject, /Winter Gala/);
  assert.deepEqual(sent[0][2].posterRows, []);
  assert.equal(sent[0][2].rows[0].date, "01.02 | 19:00");
  assert.equal(sent[0][3].bulk.batchType, "guest_first_paid_event");
  assert.deepEqual(await sendFirstPaidGuestEvent(event, "2026-2027", { ...options,
    eligible: async () => false }), { sent: 0, skipped: 1 });
  assert.equal(sent.length, 1);
  const values = new Map(), processed = [];
  const client = { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } };
  const runOptions = { now: new Date("2027-02-03T18:00:00Z"), EventModel: { find: () => query([event]) },
    clientFor: async () => client, sendEvent: async (selected, year) => {
      processed.push([selected._id, year]); return { sent: 1, skipped: 0 };
    } };
  assert.deepEqual(await runDueFirstPaidGuestEventCampaigns(runOptions), { status: "processed", sent: 1, skipped: 0 });
  assert.deepEqual(await runDueFirstPaidGuestEventCampaigns(runOptions), { status: "processed", sent: 0, skipped: 0 });
  assert.deepEqual(processed, [[event._id, "2026-2027"]]);
  assert.deepEqual(await runDueFirstPaidGuestEventCampaigns({ ...runOptions,
    now: new Date("2027-03-05T18:00:00Z"), clientFor: async () => ({ get: async () => null }) }),
  { status: "processed", sent: 0, skipped: 0 });
  assert.equal(processed.length, 1);
});

test("a failed first paid event send stays retryable", async () => {
  const values = new Map();
  const client = { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } };
  const options = { now: new Date("2027-02-03T18:00:00Z"), EventModel: { find: () => query([event]) },
    clientFor: async () => client };
  await assert.rejects(runDueFirstPaidGuestEventCampaigns({ ...options,
    sendEvent: async () => { throw new Error("Mailer unavailable"); } }), /1 first paid guest event regions failed/);
  assert.equal(values.size, 0);
  assert.deepEqual(await runDueFirstPaidGuestEventCampaigns({ ...options,
    sendEvent: async () => ({ sent: 1, skipped: 0 }) }), { status: "processed", sent: 1, skipped: 0 });
  assert.equal(values.size, 1);
});

test("a guest is suppressed after any unsubscribe or member signup", async () => {
  const base = { GuestModel: { exists: async () => true },
    MarketingModel: { find: () => query([{ consent: { granted: true }, unsubscribed: false }]) },
    MemberModel: { exists: async () => false }, AlumniModel: { exists: async () => false } };
  assert.equal(await isGuestMarketingRecipient("guest@example.test", base), true);
  assert.equal(await isGuestMarketingRecipient("guest@example.test", {
    ...base, MarketingModel: { find: () => query([
      { consent: { granted: true }, unsubscribed: false }, { consent: { granted: true }, unsubscribed: true },
    ]) },
  }), false);
  assert.equal(await isGuestMarketingRecipient("guest@example.test", {
    ...base, MemberModel: { exists: async () => true },
  }), false);
});

test("term recap deduplicates regions, calculates actual guest ticket savings and checks consent at send time", async () => {
  const sent = [], dueAt = new Date("2027-02-15T22:59:59.999Z");
  const rows = [{ email: "guest@example.test", region: "groningen", firstTicketAt: new Date("2027-02-01T18:00:00Z") }];
  const result = await sendGuestTermRecap({ term: "term2", academicYear: "2026-2027", dueAt }, {
    EventModel: { find: () => query([event]) },
    audience: async ({ region }) => region === "groningen" || region === "amsterdam" ? rows : [],
    eligible: async () => true, makeLink: () => "https://example.com/signup",
    send: async (...args) => sent.push(args),
  });
  assert.deepEqual(result, { sent: 1, skipped: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][2].total, "€20.00");
  assert.match(sent[0][2].subject, /Term 2 recap/);
  assert.equal(sent[0][2].posterRows[0].left.poster, "https://example.com/gala.png");
  assert.equal(sent[0][2].rows[0].ticketLabel, "2 tickets");
  assert.deepEqual(sent[0][2].termEvents, [{ title: "Winter Gala", date: "01.02 | 19:00", poster: "https://example.com/gala.png" }]);
  assert.equal(sent[0][3].bulk.batchType, "guest_term2_recap");
  assert.equal(guestSavingsByEmail([event], { start: new Date("2026-08-24T22:00:00Z"), cutoff: dueAt })
    .get("guest@example.test")[0].savingsCents, 2000);
});

test("a guest whose first ticket came after term end is not added during a retry", async () => {
  let queriedEvents = false;
  const result = await sendGuestTermRecap({ term: "term2", academicYear: "2026-2027",
    dueAt: new Date("2027-02-15T22:59:59.999Z") }, {
    audience: async () => [{ email: "late@example.test", region: "groningen", firstTicketAt: new Date("2027-02-16T09:00:00Z") }],
    EventModel: { find: () => { queriedEvents = true; return query([]); } },
  });
  assert.deepEqual(result, { sent: 0, skipped: 0 });
  assert.equal(queriedEvents, false);
});

test("term campaign marker is saved only after every recipient succeeds", async () => {
  const values = new Map(), attempts = [];
  const client = { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } };
  const now = new Date("2027-02-16T00:00:00Z");
  await assert.rejects(runDueGuestTermCampaigns({ now, clientFor: async () => client,
    sendRecap: async () => { attempts.push("fail"); throw new Error("Mailer unavailable"); } }), /Mailer unavailable/);
  assert.equal(values.size, 0);
  await runDueGuestTermCampaigns({ now, clientFor: async () => client,
    sendRecap: async () => { attempts.push("success"); } });
  await runDueGuestTermCampaigns({ now, clientFor: async () => client,
    sendRecap: async () => { attempts.push("duplicate"); } });
  assert.deepEqual(attempts, ["fail", "success"]);
});

test("daily guest campaign workers pass through the five-failure scheduler policy", async () => {
  const observed = [];
  const observe = async (source, name, work) => { observed.push([source, name]); return work(); };
  const options = { enabled: true, intervalMs: 600_000, process: async () => ({ status: "not-due" }), observe };
  const stopFirst = startFirstPaidGuestEventCampaignWorker(options);
  const stopTerms = startGuestTermCampaignWorker(options);
  await stopFirst();
  await stopTerms();
  assert.deepEqual(observed, [["scheduler", "guest-first-paid-event"], ["scheduler", "guest-term-recap"]]);
});
