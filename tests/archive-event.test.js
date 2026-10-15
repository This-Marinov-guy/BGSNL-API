import test from "node:test";
import assert from "node:assert/strict";
import { archiveEvent, eventArchiveCutoff, expiredEventFilter } from "../services/events/archive-event.js";

function harness() {
  const calls = [];
  const event = { _id: "a".repeat(24), status: "opened", date: new Date("2020-01-01"),
    folder: "event-folder", region: "groningen", product: { id: "prod_test" }, guestList: [{ ticket: "keep-record" }],
    save: async () => { calls.push("save"); } };
  const dependencies = { load: async () => event, lease: async (_key, run) => run({ assertOwned: async () => {} }),
    transaction: run => run({ mockSession: true }), statistics: async () => { calls.push("statistics"); },
    averages: async () => { calls.push("averages"); },
    dataPool: () => { calls.push("dataPool"); }, removeProduct: async () => { calls.push("product"); },
    removeGuestTickets: async () => { calls.push("guestTickets"); }, refresh: () => { calls.push("refresh"); } };
  return { event, calls, dependencies, run: () => archiveEvent(event._id, { dependencies }) };
}
test("archive and delete retain media and guest-list history", async () => {
  const h = harness();
  await h.run();
  assert.equal(h.event.status, "archived");
  assert.equal(h.event.isSaleClosed, true);
  assert.equal(h.event.archiveCleanupPending, false);
  assert.ok(h.event.archiveCleanupCompletedAt);
  assert.ok(h.event.mediaRetainedAt);
  assert.equal(h.event.guestList.length, 1);
  assert.deepEqual(h.calls, ["statistics", "save", "refresh", "averages", "dataPool", "guestTickets", "product", "save"]);
  await h.run();
  assert.equal(h.calls.filter(call => call === "statistics").length, 1);
  assert.equal(h.calls.filter(call => call === "averages").length, 1);
  assert.equal(h.calls.filter(call => call === "refresh").length, 1);
});
test("failed bucket cleanup stays pending and retry does not recount statistics", async () => {
  const h = harness();
  h.dependencies.removeGuestTickets = async () => { throw new Error("S3 unavailable"); };
  await assert.rejects(h.run(), /S3 unavailable/);
  assert.equal(h.event.archiveCleanupPending, true);
  assert.equal(h.event.status, "archived");
  assert.equal(h.calls.filter(call => call === "refresh").length, 1);
  h.dependencies.removeGuestTickets = async () => {};
  await h.run();
  assert.equal(h.event.archiveCleanupPending, false);
  assert.equal(h.calls.filter(call => call === "statistics").length, 1);
  assert.equal(h.calls.filter(call => call === "averages").length, 2);
  assert.equal(h.calls.filter(call => call === "refresh").length, 1);
});
test("failed average refresh remains retryable after archival commits", async () => {
  const h = harness();
  h.dependencies.averages = async () => { throw new Error("statistics unavailable"); };
  await assert.rejects(h.run(), /statistics unavailable/);
  assert.equal(h.event.status, "archived");
  assert.equal(h.event.archiveCleanupPending, true);
  h.dependencies.averages = async () => { h.calls.push("averages"); };
  await h.run();
  assert.equal(h.calls.filter(call => call === "statistics").length, 1);
  assert.equal(h.calls.filter(call => call === "averages").length, 1);
});
test("a dispatch error cannot undo a committed archival", async () => {
  const h = harness();
  h.dependencies.refresh = () => { throw new Error("GitHub unavailable"); };
  await h.run();
  assert.equal(h.event.status, "archived");
  assert.equal(h.event.archiveCleanupPending, false);
});
test("an uncommitted archival never requests a sitemap refresh", async () => {
  const h = harness();
  h.dependencies.transaction = async () => { throw new Error("transaction failed"); };
  await assert.rejects(h.run(), /transaction failed/);
  assert.equal(h.calls.includes("refresh"), false);
});
test("archive leaves the event poster URL and Cloudinary folder intact", async () => {
  const h = harness();
  h.event.poster = "https://res.cloudinary.com/bgsnl/image/upload/v1/event-folder/poster.jpg";
  await h.run();
  assert.equal(h.event.poster, "https://res.cloudinary.com/bgsnl/image/upload/v1/event-folder/poster.jpg");
  assert.equal(h.event.folder, "event-folder");
});
test("scheduler respects a corrected future date and includes pending cleanup", async () => {
  const h = harness();
  h.event.correctedDate = new Date("2099-01-01");
  assert.equal(await archiveEvent(h.event._id, { cutoff: new Date("2026-01-01"), dependencies: h.dependencies }), null);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(expiredEventFilter(new Date()).$or[1], { status: "archived", archiveCleanupPending: true });
});

test("automatic archive becomes eligible three days after the effective event date", async () => {
  const now = new Date("2026-11-24T03:15:00.000Z");
  const cutoff = eventArchiveCutoff(now);
  assert.equal(cutoff.toISOString(), "2026-11-21T03:15:00.000Z");

  const notDue = harness();
  notDue.event.date = new Date(cutoff.getTime() + 1);
  assert.equal(await archiveEvent(notDue.event._id, { cutoff, dependencies: notDue.dependencies }), null);
  assert.equal(notDue.event.status, "opened");

  const due = harness();
  due.event.date = cutoff;
  await archiveEvent(due.event._id, { cutoff, dependencies: due.dependencies });
  assert.equal(due.event.status, "archived");
});
