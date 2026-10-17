import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { FUTURE_EVENT_GRACE_MS } from "../services/public-content/event-publication.js";
import { eventSitemapExpiryEnabled, pastSitemapEventFilter,
  refreshPastEventSitemap, startEventSitemapExpiryWorker } from "../services/public-content/sitemap-expiry.js";

const now = new Date("2026-10-08T12:00:00Z");
// eslint-disable-next-line no-process-env
const uri = process.env.BGSNL_MIGRATION_TEST_URL;
if (uri && !/^mongodb:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/.test(uri)) {
  throw new Error("Sitemap integration tests only accept a local MongoDB host without a database");
}

test("past-event sweep uses the same 24-hour boundary and visibility as the public sitemap", () => {
  assert.deepEqual(pastSitemapEventFilter(now), {
    hidden: { $ne: true }, status: { $nin: ["archived", "draft"] }, region: { $ne: "netherlands" },
    $expr: { $and: [
      { $eq: [{ $type: { $ifNull: ["$correctedDate", "$date"] } }, "date"] },
      { $lte: [{ $ifNull: ["$correctedDate", "$date"] }, new Date(+now - FUTURE_EVENT_GRACE_MS)] },
      { $ne: ["$sitemapPastRefreshedFor", { $ifNull: ["$correctedDate", "$date"] }] },
    ] },
  });
});

const model = (events, marked) => ({
  find: () => ({ select: () => ({ limit: () => ({ lean: async () => events }) }) }),
  updateOne: async (filter, update) => { marked.push({ filter, update }); return { modifiedCount: 1 }; },
});

test("one accepted dispatch marks every due event using its effective date", async () => {
  const marked = [], calls = [];
  const original = new Date("2026-10-01T10:00:00Z");
  const corrected = new Date("2026-10-02T10:00:00Z");
  const events = [
    { _id: "first", date: original, region: "groningen" },
    { _id: "second", date: original, correctedDate: corrected, region: "amsterdam" },
  ];
  const result = await refreshPastEventSitemap({ now, EventModel: model(events, marked),
    refresh: async (change, event) => { calls.push([change, event._id]); return true; } });
  assert.deepEqual(calls, [["past", "first"]]);
  assert.deepEqual(marked, [
    { filter: { _id: "first", correctedDate: null, date: original }, update: { $set: { sitemapPastRefreshedFor: original } } },
    { filter: { _id: "second", correctedDate: corrected }, update: { $set: { sitemapPastRefreshedFor: corrected } } },
  ]);
  assert.deepEqual(result, { expired: 2, refreshed: true });
});

test("failed dispatch leaves every event available for the next sweep", async () => {
  const marked = [];
  await assert.rejects(refreshPastEventSitemap({ now,
    EventModel: model([{ _id: "event", date: new Date("2026-10-01") }], marked),
    refresh: async () => false,
  }), /not accepted/);
  assert.deepEqual(marked, []);
});

test("empty sweeps do not dispatch and the worker is limited to production worker zero", async () => {
  assert.deepEqual(await refreshPastEventSitemap({ now, EventModel: model([], []),
    refresh: () => assert.fail("No dispatch without an expired event") }), { skipped: true, expired: 0, refreshed: false });
  const credentials = { GITHUB_SITEMAP_REPOSITORY: "owner/repo", GITHUB_SITEMAP_DISPATCH_TOKEN: "test-token" };
  assert.equal(eventSitemapExpiryEnabled({ ...credentials, NODE_ENV: "production", NODE_APP_INSTANCE: "0" }), true);
  assert.equal(eventSitemapExpiryEnabled({ ...credentials, NODE_ENV: "production", NODE_APP_INSTANCE: "1" }), false);
  assert.equal(eventSitemapExpiryEnabled({ NODE_ENV: "development" }), false);
  assert.equal(eventSitemapExpiryEnabled({ NODE_ENV: "production" }), false);
  const stop = startEventSitemapExpiryWorker({ enabled: false,
    schedule: () => assert.fail("Disabled worker must not schedule") });
  await stop();
});

test("MongoDB sweep selects only newly past public events and persists idempotency", { skip: !uri }, async t => {
  const client = await new MongoClient(uri).connect();
  const db = client.db(`bgsnl_sitemap_test_${randomUUID().replaceAll("-", "")}`);
  t.after(async () => { await db.dropDatabase(); await client.close(); });
  const events = db.collection("events");
  const old = new Date("2026-10-06T11:59:59Z");
  const boundary = new Date("2026-10-06T12:00:00Z");
  const future = new Date("2026-10-06T12:00:01Z");
  await events.insertMany([
    { _id: "old", region: "groningen", status: "opened", date: old },
    { _id: "boundary", region: "groningen", status: "closed", date: boundary },
    { _id: "future", region: "groningen", status: "opened", date: future },
    { _id: "corrected-past", region: "groningen", status: "opened", date: future, correctedDate: old },
    { _id: "corrected-future", region: "groningen", status: "opened", date: old, correctedDate: future },
    { _id: "hidden", region: "groningen", status: "opened", date: old, hidden: true },
    { _id: "archived", region: "groningen", status: "archived", date: old },
    { _id: "draft", region: "groningen", status: "draft", date: old },
    { _id: "national", region: "netherlands", status: "opened", date: old },
    { _id: "already", region: "groningen", status: "opened", date: old, sitemapPastRefreshedFor: old },
  ]);
  const adapter = {
    find(filter) { return { select() { return this; }, limit(amount) { this.amount = amount; return this; },
      lean() { return events.find(filter).limit(this.amount).toArray(); } }; },
    updateOne: (filter, update) => events.updateOne(filter, update),
  };
  const selected = await events.find(pastSitemapEventFilter(now)).project({ _id: 1 }).toArray();
  assert.deepEqual(selected.map(event => event._id).sort(), ["boundary", "corrected-past", "old"]);
  let dispatches = 0;
  assert.deepEqual(await refreshPastEventSitemap({ now, EventModel: adapter,
    refresh: async () => { dispatches++; return true; } }), { expired: 3, refreshed: true });
  assert.equal(dispatches, 1);
  assert.equal(await events.countDocuments(pastSitemapEventFilter(now)), 0);
  assert.deepEqual(await refreshPastEventSitemap({ now, EventModel: adapter,
    refresh: async () => { dispatches++; return true; } }), { skipped: true, expired: 0, refreshed: false });
  assert.equal(dispatches, 1);
});
