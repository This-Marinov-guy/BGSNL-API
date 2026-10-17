import assert from "node:assert/strict";
import test from "node:test";
import { monthlyPeriod, nextMonthlySummaryTime, summaryIsDue, isActiveSummaryAlumni, validateNews, safeHttpsUrl } from "../services/monthly-summary/policy.js";
import { loadMonthlyArticles, loadMonthlySnapshot, loadMonthlyRecipients } from "../services/monthly-summary/data.js";
import { buildMonthlySummaryEmail } from "../services/monthly-summary/email.js";
import { MONTHLY_SUPPORTER_SUMMARY_TEMPLATE, monthlySummaryConfig, processMonthlySummary, startMonthlySummaryWorker } from "../services/monthly-summary/worker.js";
import { createMonthlySummaryControllers } from "../controllers/monthly-summary-controller.js";

const now = new Date("2026-10-31T22:59:00Z");
const snapshot = { month: "2026-10", label: "October 2026", members: 12, alumni: 3, ticketsSold: 0,
  cutoff: now.toISOString(), articles: [], news: [], events: [] };
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
      { _id: "event2", title: "Second", date: "2026-10-02", correctedDate: "2026-10-20", region: "amsterdam", poster: "https://example.com/poster.png", guestList: [{ refunded: false }, { refunded: true }, {}] },
      { _id: "event1", title: "First", date: "2026-10-01", region: "groningen", poster: "javascript:bad", guestList: [{ refunded: false }] },
    ]); } },
    loadCounts: async input => { countsPeriod = input; return { totals: { members: 4, alumni: 2 } }; },
    loadArticles: async () => [{ title: "October stories", description: "New voices", url: "https://example.com/article" }],
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
  assert.equal(result.ticketsSold, 3);
  assert.equal(result.articles[0].title, "October stories");
});

test("snapshot is calculated live rather than reused from a saved draft", async () => {
  const result = await loadMonthlySnapshot("2026-10", { now, draft: { snapshot },
    EventModel: { find: () => queryResult([]) },
    loadCounts: async () => ({ totals: { members: 7, alumni: 2 } }),
    loadArticles: async () => [],
  });
  assert.equal(result.members, 7);
  assert.deepEqual(result.news, []);
});

test("monthly articles use the publication month and omit translated Bulgarian posts", async () => {
  const period = monthlyPeriod("2026-10", now);
  const articles = await loadMonthlyArticles(period, {
    blogId: "example.wordpress.com",
    fetchPage: async () => [
      { id: 10, date_gmt: "2026-10-15T12:00:00", title: { rendered: "Autumn &amp; Community" },
        excerpt: { rendered: "<p>Friends met &amp; shared stories.</p>" },
        content: { rendered: '<figure><img src="https://example.com/article-photo.jpg?w=600&amp;h=600"></figure>' } },
      { id: 11, date_gmt: "2026-10-15T12:00:00", title: { rendered: "Bulgarian translation" } },
      { id: 12, date_gmt: "2026-09-30T21:59:59", title: { rendered: "Too early" } },
    ],
    loadTranslations: async () => ["10", "11"],
  });
  assert.deepEqual(articles, [{ title: "Autumn & Community", description: "Friends met & shared stories.",
    image: "https://example.com/article-photo.jpg?w=600&h=600",
    url: "https://www.bulgariansociety.nl/articles/10/autumn-community" }]);
});

test("news is optional, bounded, validated and escaped in email HTML", () => {
  assert.deepEqual(validateNews([]), []);
  assert.throws(() => validateNews([{ title: "", body: "Text" }]), /item 1/);
  assert.throws(() => validateNews([{ title: "Title", body: "Text", url: "javascript:alert(1)" }]), /HTTPS/);
  assert.throws(() => validateNews(Array.from({ length: 11 }, () => ({ title: "Title", body: "Body" }))), /10/);
  assert.equal(safeHttpsUrl("https://user:password@example.com"), "");
  const email = buildMonthlySummaryEmail({ ...snapshot, ticketsSold: 18,
    events: [{ title: '<img src=x onerror="alert(1)">', date: "2026-10-12", poster: "https://example.com/poster.png", url: "https://example.com/event" }],
    articles: [{ title: "October stories", description: "From our community", image: "https://example.com/article-photo.jpg",
      url: "https://www.bulgariansociety.nl/articles/10/october-stories" }],
    news: validateNews([{ title: "<script>bad</script>", body: "Line one\nLine two", url: "https://example.com/news" }]),
  });
  assert.match(email.html, /Thank you for supporting Bulgarian Society Netherlands/);
  assert.match(email.htmlBody, /Thank you for supporting Bulgarian Society Netherlands/);
  assert.doesNotMatch(email.htmlBody, /<body|<html/i);
  assert.match(email.html, /poster.png/);
  assert.match(email.htmlBody, /class="monthly-poster-grid"/);
  assert.match(email.htmlBody, /width="220"[^>]*max-width:220px;height:auto;max-height:280px;object-fit:contain/);
  assert.doesNotMatch(email.htmlBody, /class="bgsnl-event-preview"/);
  assert.match(email.htmlBody, /class="monthly-growth"/);
  assert.match(email.htmlBody, /bgsnl-monthly-member-20261011\.png" width="32" height="32" alt=""/);
  assert.match(email.htmlBody, /bgsnl-monthly-alumni-20261011\.png" width="32" height="32" alt=""/);
  assert.match(email.htmlBody, /bgsnl-monthly-ticket-20261011\.png" width="32" height="32" alt=""/);
  assert.match(email.htmlBody, />18<\/strong>total tickets sold/);
  assert.match(email.htmlBody, />12<\/strong>new members/);
  assert.match(email.htmlBody, />3<\/strong>new alumni/);
  assert.doesNotMatch(email.htmlBody, /12\.10 \| 02:00/);
  assert.match(email.text, /12\.10 \| 02:00/);
  assert.match(email.htmlBody, /Articles of the month/);
  assert.match(email.htmlBody, /class="monthly-article-row"/);
  assert.match(email.htmlBody, /article-photo\.jpg" width="112" height="112" alt=""/);
  assert.match(email.htmlBody, /October stories<\/strong><a href="https:\/\/www\.bulgariansociety\.nl\/articles\/10\/october-stories"[^>]*min-height:44px[^>]*>Read more<\/a>/);
  assert.doesNotMatch(email.htmlBody, /From our community/);
  assert.match(email.htmlBody, /Community updates/);
  assert.match(email.html, /&lt;script&gt;/);
  assert.doesNotMatch(email.html, /<script>|<img src=x/);
  assert.match(email.html, /Line one<br>Line two/);
  assert.match(email.text, /12 new members/);
  assert.match(email.text, /3 new alumni/);
  assert.match(email.text, /Total tickets sold: 18/);
  assert.doesNotMatch(buildMonthlySummaryEmail(snapshot).html, /Articles of the month|Community updates|Figures as of/);
  assert.match(buildMonthlySummaryEmail(snapshot).html, /No events took place/);
  const noGrowth = buildMonthlySummaryEmail({ ...snapshot, members: 0, alumni: 0 });
  assert.doesNotMatch(noGrowth.htmlBody, /Our community grew|monthly-member|monthly-alumni|new members|new alumni/);
  const oneGrowth = buildMonthlySummaryEmail({ ...snapshot, members: 0, alumni: 2 });
  assert.doesNotMatch(oneGrowth.htmlBody, /monthly-member|new members/);
  assert.match(oneGrowth.htmlBody, /monthly-alumni|new alumni/);
});

test("monthly job sends as one Mailer campaign batch and relies on its sheet log", async () => {
  const messages = [];
  const result = await processMonthlySummary({ now, config: { enabled: true, internalEmails: [] },
    loadSnapshot: async () => snapshot,
    loadRecipients: async () => ({ emails: ["alumni@example.com", "internal@example.com"] }),
    send: async (template, receiver, variables, options) => {
      messages.push({ template, receiver, variables, options });
      if (receiver === "alumni@example.com") throw new Error("timeout");
    },
  });
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].template, MONTHLY_SUPPORTER_SUMMARY_TEMPLATE);
  assert.match(messages[0].options.operationId, /^[0-9a-f-]{36}$/);
  assert.match(messages[0].variables.subject, /October 2026/);
  assert.doesNotMatch(messages[0].variables.html, /<body|<html/i);
  assert.equal(messages[0].options.bulk.batchType, "monthly_supporter_summary");
  assert.equal(messages[0].options.bulk.totalRecipients, 2);
  assert.equal(messages[0].options.bulk.batchId, messages[1].options.bulk.batchId);
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
    getConfig: () => ({ internalEmails: [] }),
    loadSnapshot: async () => snapshot,
    loadRecipients: async () => ({ emails: ["private@example.com"], alumniCount: 1, internalCount: 0 }),
  });
  let response;
  await controllers.get({ params: { month: "2026-10" } }, { json: body => { response = body; } }, error => { throw error; });
  assert.equal(response.month, "2026-10");
  assert.equal(response.recipients.total, 1);
  assert.doesNotMatch(JSON.stringify(response), /private@example.com/);
});
