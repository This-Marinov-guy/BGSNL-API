import assert from "node:assert/strict";
import test from "node:test";
import { createEmailRunGuard } from "../services/background-services/email-run-guard.js";
import { processRegionalMembershipReports, startRegionalMembershipReportWorker } from "../services/background-services/regional-membership-report.js";

const row = (region, city, members, alumni = 0) => ({ region, city, members, alumni, total: members + alumni });
const setup = () => {
  const messages = [];
  return { messages, options: {
    now: new Date("2026-10-04T16:00:00Z"),
    config: { enabled: true, subscribers: [], timeZone: "Europe/Amsterdam" },
    runGuard: createEmailRunGuard(),
    loadContacts: async () => ({ groningen: "gro@example.com", amsterdam: "ams@example.com", rotterdam: "rtm@example.com", netherlands: "nl@example.com", support: "help@example.com" }),
    loadSummary: async () => ({ rows: [
      row("groningen", "Groningen", 2, 1), row("amsterdam", "Amsterdam", 1),
      row("rotterdam", "Rotterdam", 0, 2), row("maastricht", "Maastricht", 0),
      row("netherlands", "Netherlands", 4), row("unassigned", "Unassigned", 1),
    ] }),
    send: async (message) => messages.push(message),
  } };
};

test("sends only to regions with new members, even without national subscribers", async () => {
  const { options, messages } = setup();
  const result = await processRegionalMembershipReports(options);
  assert.equal(result.sent, 2);
  assert.deepEqual(messages.map(message => message.receiver), ["gro@example.com", "ams@example.com"]);
  assert.match(messages[0].text, /Groningen: 2 members, 1 alumnus, 3 total/);
  assert.doesNotMatch(messages[0].html, />Amsterdam<|>Rotterdam<|All cities/);
  assert.match(messages[0].html, /New members and alumni/);
  assert.match(messages[0].subject, /Groningen/);
  assert.equal(messages[0].type, "regional-weekly-membership-summary");
});

test("no recipients in an empty week", async () => {
  const { options, messages } = setup();
  options.loadSummary = async () => ({ rows: [row("groningen", "Groningen", 0)] });
  assert.equal((await processRegionalMembershipReports(options)).sent, 0);
  assert.equal(messages.length, 0);
});

test("one attempt per region and week, including after an ambiguous provider failure", async () => {
  const { options, messages } = setup();
  options.send = async message => { messages.push(message); if (message.receiver === "gro@example.com") throw new Error("timeout"); };
  const first = await processRegionalMembershipReports(options);
  assert.equal(first.sent, 1);
  assert.equal(first.failed, 1);
  const repeat = await processRegionalMembershipReports(options);
  assert.equal(repeat.sent, 0);
  assert.equal(repeat.skipped, 2);
  assert.equal(messages.length, 2);
});

test("missing directory entry never falls back to another region's inbox", async () => {
  const { options, messages } = setup();
  options.loadContacts = async () => ({ groningen: "new-address@example.com" });
  const result = await processRegionalMembershipReports(options);
  assert.equal(result.missingContacts, 1);
  assert.equal(result.status, "delivery-failed");
  assert.equal(messages[0].receiver, "new-address@example.com");
});

test("disabled and off-schedule jobs do not query the directory or send", async () => {
  const { options } = setup();
  options.loadContacts = async () => assert.fail("Must not query");
  options.config.enabled = false;
  assert.equal((await processRegionalMembershipReports(options)).status, "disabled");
  options.config.enabled = true;
  for (const date of ["2026-10-01T16:00:00Z", "2026-10-04T16:01:00Z"]) {
    options.now = new Date(date);
    assert.equal((await processRegionalMembershipReports(options)).status, "not-due");
  }
});

test("uses the same consecutive local week boundaries as the internal report", async () => {
  const { options } = setup();
  options.loadSummary = async period => {
    assert.equal(period.periodStart.toISOString(), "2026-09-27T16:00:00.000Z");
    assert.equal(period.periodEnd.toISOString(), "2026-10-04T16:00:00.000Z");
    return { rows: [] };
  };
  await processRegionalMembershipReports(options);
});

test("regional worker schedules without startup send and has its own observed job name", async () => {
  let timer, calls = 0;
  const names = [];
  const stop = startRegionalMembershipReportWorker({
    config: { enabled: true, timeZone: "Europe/Amsterdam" },
    now: () => new Date("2026-10-01T16:00:00Z"),
    schedule: (callback, delay) => { timer = { callback, delay }; return timer; },
    cancel: () => {},
    observe: (_source, name, work) => { names.push(name); return work(); },
    processReport: async () => { calls++; },
  });
  assert.equal(calls, 0);
  assert.equal(timer.delay, 3 * 24 * 3600000);
  timer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(names, ["regional-membership-report"]);
  await stop();
});
