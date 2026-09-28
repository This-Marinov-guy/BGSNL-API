import test from "node:test";
import assert from "node:assert/strict";
import { archiveEvent, expiredEventFilter } from "../services/events/archive-event.js";

function harness() {
  const calls = [];
  const event = { _id: "a".repeat(24), status: "opened", date: new Date("2020-01-01"),
    folder: "event-folder", region: "groningen", product: { id: "prod_test" }, guestList: [{ ticket: "keep-record" }],
    save: async () => { calls.push("save"); } };
  const dependencies = { load: async () => event, lease: async (_key, run) => run({ assertOwned: async () => {} }),
    transaction: run => run({ mockSession: true }), statistics: async () => { calls.push("statistics"); },
    dataPool: () => { calls.push("dataPool"); }, removeProduct: async () => { calls.push("product"); },
    removeFolder: async () => { calls.push("folder"); }, removeGuestTickets: async () => { calls.push("guestTickets"); } };
  return { event, calls, dependencies, run: () => archiveEvent(event._id, { dependencies }) };
}
test("archive and delete share cleanup without deleting the guest-list history", async () => {
  const h = harness();
  await h.run();
  assert.equal(h.event.status, "archived");
  assert.equal(h.event.isSaleClosed, true);
  assert.equal(h.event.archiveCleanupPending, false);
  assert.ok(h.event.archiveCleanupCompletedAt);
  assert.equal(h.event.guestList.length, 1);
  assert.deepEqual(h.calls, ["statistics", "save", "dataPool", "guestTickets", "product", "folder", "save"]);
  await h.run();
  assert.equal(h.calls.filter(call => call === "statistics").length, 1);
});
test("failed bucket cleanup stays pending and retry does not recount statistics", async () => {
  const h = harness();
  h.dependencies.removeGuestTickets = async () => { throw new Error("S3 unavailable"); };
  await assert.rejects(h.run(), /S3 unavailable/);
  assert.equal(h.event.archiveCleanupPending, true);
  assert.equal(h.event.status, "archived");
  h.dependencies.removeGuestTickets = async () => {};
  await h.run();
  assert.equal(h.event.archiveCleanupPending, false);
  assert.equal(h.calls.filter(call => call === "statistics").length, 1);
});
test("scheduler respects a corrected future date and includes pending cleanup", async () => {
  const h = harness();
  h.event.correctedDate = new Date("2099-01-01");
  assert.equal(await archiveEvent(h.event._id, { cutoff: new Date("2026-01-01"), dependencies: h.dependencies }), null);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(expiredEventFilter(new Date()).$or[1], { status: "archived", archiveCleanupPending: true });
});
