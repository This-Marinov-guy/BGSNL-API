import assert from "node:assert/strict";
import test from "node:test";
import { monthlyPeriod, nextMonthlySummaryTime, summaryIsDue, isActiveSummaryAlumni, validateNews, safeHttpsUrl } from "../services/monthly-summary/policy.js";
import { loadMonthlySnapshot, loadMonthlyRecipients, claimMonthlyDelivery, freezeMonthlySnapshot, saveMonthlyNews } from "../services/monthly-summary/data.js";
import { buildMonthlySummaryEmail } from "../services/monthly-summary/email.js";
import { monthlySummaryConfig, processMonthlySummary, startMonthlySummaryWorker } from "../services/monthly-summary/worker.js";
import { createMonthlySummaryControllers } from "../controllers/monthly-summary-controller.js";

const now = new Date("2026-10-31T22:59:00Z");
const snapshot = { month: "2026-10", label: "October 2026", members: 12, alumni: 3,
  cutoff: now.toISOString(), news: [], events: [] };
const active = { email: "alumni@example.com", status: "active", tier: 2, notificationTerms: true,
  notificationTypeTerms: "whatsapp & email", expireDate: new Date("2026-12-01"), roles: ["alumni"],
  subscription: { id: "sub_paid", hasBenefits: true, lockReason: null } };
const queryResult = rows => ({ select: () => ({ maxTimeMS: () => ({ lean: async () => rows }) }) });

test("month-end schedule handles month lengths, leap years and Amsterdam DST", () => {
  for (const [date, expected] of [
    ["2026-10-01T00:00:00Z", "2026-10-31T22:59:00.000Z"],
    ["2026-02-01T00:00:00Z", "2026-02-28T22:59:00.000Z"],
    ["2028-02-01T00:00:00Z", "2028-02-29T22:59:00.000Z"],
    ["2026-04-01T00:00:00Z", "2026-04-30T21:59:00.000Z"],
    ["2026-12-31T22:59:00Z", "2027-01-31T22:59:00.000Z"],
  ]) assert.equal(nextMonthlySummaryTime(new Date(date)).toISOString(), expected);
  const period = monthlyPeriod("2026-10", now);
  assert.equal(period.periodStart.toISOString(), "2026-09-30T22:00:00.000Z");
  assert.equal(period.periodEnd.toISOString(), "2026-10-31T23:00:00.000Z");
  assert.equal(summaryIsDue(now), true);
  assert.equal(summaryIsDue(new Date("2026-10-31T22:58:59Z")), false);
  assert.equal(summaryIsDue(new Date("2026-10-31T23:00:00Z")), false);
  assert.throws(() => monthlyPeriod("2026-13"), /valid month/);
});

test("only current paid-tier alumni with email permission are eligible", () => {
  assert.equal(isActiveSummaryAlumni(active, now), true);
  assert.equal(isActiveSummaryAlumni({ ...active, subscription: { ...active.subscription, status: "canceled" } }, now), true);
  for (const patch of [{ tier: 0 }, { status: "locked" }, { status: "alumni-migrated" },
    { notificationTerms: false }, { notificationTypeTerms: "whatsapp" }, { expireDate: new Date("2026-09-01") },
    { email: "not-an-email" }, { subscription: { id: "sub_1", hasBenefits: false } },
    { subscription: { id: "sub_1", hasBenefits: true, lockReason: "payment_failed" } },
  ]) assert.equal(isActiveSummaryAlumni({ ...active, ...patch }, now), false, JSON.stringify(patch));
  assert.equal(isActiveSummaryAlumni({ ...active, subscription: {} }, now), true);
});

test("recipients are normalized and deduplicated across alumni and internal lists", async () => {
  const AlumniModel = { find: query => {
    assert.equal(query.status, "active");
    assert.equal(query.notificationTerms, true);
    return queryResult([active, { ...active, email: " ALUMNI@EXAMPLE.COM " }, { ...active, email: "skip@example.com", tier: 0 }]);
  } };
  const result = await loadMonthlyRecipients({ now, AlumniModel, internalEmails: ["ALUMNI@example.com", "internal@example.com", "bad"] });
  assert.deepEqual(result, { emails: ["alumni@example.com", "internal@example.com"], alumniCount: 1, internalCount: 1 });
});

test("snapshot includes archived events, uses corrected dates, excludes hidden/cancelled/draft events and future dates", async () => {
  let query, countsPeriod;
  const result = await loadMonthlySnapshot("2026-10", { now, draft: { news: [] },
    EventModel: { find: input => { query = input; return queryResult([
      { _id: "event2", title: "Second", date: "2026-10-02", correctedDate: "2026-10-20", region: "amsterdam", poster: "https://example.com/poster.png" },
      { _id: "event1", title: "First", date: "2026-10-01", region: "groningen", poster: "javascript:bad" },
    ]); } },
    loadCounts: async input => { countsPeriod = input; return { totals: { members: 4, alumni: 2 } }; },
  });
  assert.deepEqual(query.status.$nin, ["draft", "cancelled", "canceled"]);
  assert.deepEqual(query.hidden, { $ne: true });
  assert.deepEqual(query.$expr.$and[0].$gte[0], { $ifNull: ["$correctedDate", "$date"] });
  assert.equal(query.$expr.$and[1].$lt[1].toISOString(), now.toISOString());
  assert.equal(countsPeriod.periodEnd.toISOString(), now.toISOString());
  assert.deepEqual(result.events.map(event => event.id), ["event1", "event2"]);
  assert.equal(result.events[0].poster, "");
  assert.equal(result.members, 4);
  assert.equal(result.alumni, 2);
});

test("published snapshots are reused without recalculating history", async () => {
  assert.deepEqual(await loadMonthlySnapshot("2026-10", { now, draft: { snapshot },
    EventModel: { find: () => assert.fail("Frozen data should be reused") } }), snapshot);
});

test("news is optional, bounded, validated and escaped in email HTML", () => {
  assert.deepEqual(validateNews([]), []);
  assert.throws(() => validateNews([{ title: "", body: "Text" }]), /item 1/);
  assert.throws(() => validateNews([{ title: "Title", body: "Text", url: "javascript:alert(1)" }]), /HTTPS/);
  assert.throws(() => validateNews(Array.from({ length: 11 }, () => ({ title: "Title", body: "Body" }))), /10/);
  assert.equal(safeHttpsUrl("https://user:password@example.com"), "");
  const email = buildMonthlySummaryEmail({ ...snapshot,
    events: [{ title: '<img src=x onerror="alert(1)">', date: "2026-10-12", poster: "https://example.com/poster.png", url: "https://example.com/event" }],
    news: validateNews([{ title: "<script>bad</script>", body: "Line one\nLine two", url: "https://example.com/news" }]),
  });
  assert.match(email.html, /Thank you for supporting Bulgarian Society Netherlands/);
  assert.match(email.html, /poster.png/);
  assert.match(email.html, /12 October 2026/);
  assert.match(email.html, /&lt;script&gt;/);
  assert.doesNotMatch(email.html, /<script>|<img src=x/);
  assert.match(email.html, /Line one<br>Line two/);
  assert.match(email.text, /12 new members and 3 new alumni/);
  assert.doesNotMatch(buildMonthlySummaryEmail(snapshot).html, /Society news/);
  assert.match(buildMonthlySummaryEmail(snapshot).html, /No events took place/);
});

test("draft saves use revision checks and reject closed months", async () => {
  let query, options;
  const SummaryModel = { findOneAndUpdate: (filter, _update, config) => {
    query = filter; options = config; return { lean: async () => ({ _id: "2026-10", revision: 2, news: [] }) };
  } };
  await saveMonthlyNews({ month: "2026-10", revision: 1, news: [], userId: "admin" }, { now: new Date("2026-10-01"), SummaryModel });
  assert.deepEqual(query, { _id: "2026-10", revision: 1, publishedAt: null });
  assert.equal(options.upsert, false);
  await assert.rejects(saveMonthlyNews({ month: "2026-10", revision: 1, news: [] }, { now, SummaryModel }), /closed/);
  const conflict = { findOneAndUpdate: () => ({ lean: async () => null }) };
  await assert.rejects(saveMonthlyNews({ month: "2026-10", revision: 1, news: [] }, { now: new Date("2026-10-01"), SummaryModel: conflict }), /changed/);
});

test("atomic publication uses latest saved news and reuses another worker's snapshot", async () => {
  const SummaryModel = { findOneAndUpdate: (_filter, pipeline) => {
    assert.deepEqual(pipeline[1], { $set: { "snapshot.news": "$news" } });
    assert.deepEqual(pipeline[0].$set.snapshot, { $literal: snapshot });
    return { lean: async () => ({ snapshot }) };
  } };
  assert.deepEqual(await freezeMonthlySnapshot("2026-10", snapshot, { now, SummaryModel }), snapshot);
  const concurrent = { findOneAndUpdate: () => ({ lean: async () => { throw { code: 11000 }; } }),
    findById: () => ({ lean: async () => ({ snapshot }) }) };
  assert.deepEqual(await freezeMonthlySnapshot("2026-10", snapshot, { now, SummaryModel: concurrent }), snapshot);
});

test("durable recipient claim prevents repeat attempts across process guards", async () => {
  const ids = new Set();
  const DeliveryModel = { create: async document => {
    assert.equal(document.status, "attempted");
    assert.doesNotMatch(document._id, /@/);
    if (ids.has(document._id)) throw { code: 11000 };
    ids.add(document._id);
  } };
  assert.ok(await claimMonthlyDelivery("2026-10", " User@Example.com ", { now, DeliveryModel }));
  assert.equal(await claimMonthlyDelivery("2026-10", "user@example.com", { now, DeliveryModel }), null);
  assert.ok(await claimMonthlyDelivery("2026-11", "user@example.com", { now, DeliveryModel }));
});

test("monthly job combines audiences, isolates provider failure and never blindly retries", async () => {
  const claimed = new Set(), finishes = [], messages = [];
  const options = { now, config: { enabled: true, internalEmails: ["internal@example.com"] },
    loadSnapshot: async () => snapshot, freeze: async (_month, data) => data,
    loadRecipients: async () => ({ emails: ["alumni@example.com", "internal@example.com"] }),
    claim: async (month, email) => { const id = `${month}:${email}`; if (claimed.has(id)) return null; claimed.add(id); return id; },
    finish: async (id, status) => finishes.push({ id, status }),
    send: async message => { messages.push(message); if (message.receiver === "alumni@example.com") throw new Error("timeout"); },
  };
  const first = await processMonthlySummary(options);
  assert.equal(first.sent, 1); assert.equal(first.failed, 1);
  assert.deepEqual(finishes.map(entry => entry.status), ["uncertain", "sent"]);
  const second = await processMonthlySummary(options);
  assert.equal(second.sent, 0); assert.equal(second.skipped, 2);
  assert.equal(messages.length, 2);
});

test("disabled or off-schedule jobs cannot send or query", async () => {
  const loadSnapshot = async () => assert.fail("No data access outside schedule");
  assert.equal((await processMonthlySummary({ config: { enabled: false }, now, loadSnapshot })).status, "disabled");
  assert.equal((await processMonthlySummary({ config: { enabled: true }, now: new Date("2026-10-01"), loadSnapshot })).status, "not-due");
  assert.equal(monthlySummaryConfig({ NODE_ENV: "development" }).enabled, false);
  assert.equal(monthlySummaryConfig({ NODE_ENV: "production", NODE_APP_INSTANCE: "1" }).enabled, false);
  assert.deepEqual(monthlySummaryConfig({ NODE_ENV: "production", INTERNAL_NOTIFICATIONS_ENABLED: "true" }).internalEmails, ["notifications@bulgariansociety.nl"]);
});

test("worker bounds timers below 24h and sends only at month end, never on startup", async () => {
  let current = new Date("2026-10-01"), timer, calls = 0;
  const stop = startMonthlySummaryWorker({ config: { enabled: true }, now: () => current,
    schedule: (callback, delay) => { timer = { callback, delay }; return timer; }, cancel: () => {},
    observe: (_source, name, work) => { assert.equal(name, "monthly-supporter-summary"); return work(); },
    processSummary: async () => { calls++; },
  });
  assert.equal(calls, 0); assert.equal(timer.delay, 86400000);
  current = new Date("2026-10-02"); timer.callback();
  assert.equal(calls, 0); assert.equal(timer.delay, 86400000);
  current = now; timer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(timer.delay, 86400000);
  await stop(); timer.callback(); assert.equal(calls, 1);
});

test("preview only exposes counts and email content, never recipient addresses", async () => {
  const controllers = createMonthlySummaryControllers({ now: () => new Date("2026-10-01"),
    getConfig: () => ({ internalEmails: [] }), loadDraft: async () => ({ news: [], revision: 0 }),
    loadSnapshot: async () => snapshot,
    loadRecipients: async () => ({ emails: ["private@example.com"], alumniCount: 1, internalCount: 0 }),
  });
  let response;
  await controllers.get({ params: { month: "2026-10" } }, { json: body => { response = body; } }, error => { throw error; });
  assert.equal(response.editable, true);
  assert.equal(response.recipients.total, 1);
  assert.doesNotMatch(JSON.stringify(response), /private@example.com/);
});
