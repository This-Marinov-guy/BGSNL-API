import assert from "node:assert/strict";
import test from "node:test";
import {
  GUEST_LIST_RECONCILIATION_INTERVAL_MS,
  reconcileGuestLists,
  scheduleGuestListReconciliation,
} from "../services/jobs/guest-list-reconciliation.js";

const model = (records, filters) => ({
  find(filter) {
    filters.push(filter);
    return { select() { return this; }, limit() { return this; }, lean: async () => records };
  },
});

test("reconciliation requeues recent society and special guest lists through the background queue", async () => {
  const filters = [], added = [];
  const result = await reconcileGuestLists({
    eventModel: model([{ _id: "event-a" }, { _id: "event-b" }], filters),
    specialEventModel: model([{ _id: "special-a" }], filters),
    enqueue: async (type, data) => { added.push([type, data]); },
    now: new Date("2026-09-29T12:00:00.000Z"),
  });
  assert.deepEqual(result, { events: 2, specialEvents: 1 });
  assert.deepEqual(added, [
    ["event", { id: "event-a" }], ["event", { id: "event-b" }],
    ["special-event", { id: "special-a" }],
  ]);
  assert.equal(filters[0].$or[0].date.$gte.toISOString(), "2026-08-30T12:00:00.000Z");
  assert.equal(filters[0].$or[1].correctedDate.$gte.toISOString(), "2026-08-30T12:00:00.000Z");
  assert.equal(filters[0]["guestList.0"].$exists, true);
  assert.equal(filters[0].status.$ne, "draft");
  assert.equal(filters[0].sheetName.$ne, "");
});

test("reconciliation fails rather than silently skipping more than 500 events", async () => {
  let enqueued = 0;
  await assert.rejects(reconcileGuestLists({
    eventModel: model(Array.from({ length: 501 }, (_, index) => ({ _id: String(index) })), []),
    specialEventModel: model([], []),
    enqueue: async () => { enqueued += 1; },
  }), /Too many recent guest lists/);
  assert.equal(enqueued, 0);
});

test("the worker registers one recurring reconciliation job with retries", async () => {
  let scheduled;
  await scheduleGuestListReconciliation(() => ({ upsertJobScheduler: async (...args) => { scheduled = args; } }));
  assert.equal(scheduled[0], "reconcile-guest-lists");
  assert.equal(scheduled[1].every, GUEST_LIST_RECONCILIATION_INTERVAL_MS);
  assert.equal(scheduled[2].name, "reconcile-guest-lists");
  assert.equal(scheduled[2].opts.attempts, 3);
});
