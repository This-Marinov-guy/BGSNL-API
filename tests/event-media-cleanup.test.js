import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnnualEventMediaCleanupJob, eventMediaCleanupDueAt, getEventMediaCleanupConfig,
  nextEventMediaCleanupAt, rememberDeletedDraftMedia, runAnnualEventMediaCleanup, runEventMediaCleanup,
} from "../services/events/event-media-cleanup.js";

const chain = value => ({ select: () => ({ limit: () => ({ lean: async () => value }), lean: async () => value }) });

test("annual cutoff uses Amsterdam time and defers events inside the 72-hour email window", () => {
  assert.equal(nextEventMediaCleanupAt("2026-07-01T12:00:00Z").toISOString(), "2026-08-25T01:00:00.000Z");
  assert.equal(nextEventMediaCleanupAt("2026-10-05T12:00:00Z").toISOString(), "2027-08-25T01:00:00.000Z");
  assert.equal(eventMediaCleanupDueAt({ date: "2026-08-22T01:00:00Z" }, "2026-07-01T00:00:00Z").toISOString(), "2026-08-25T01:00:00.000Z");
  assert.equal(eventMediaCleanupDueAt({ date: "2026-08-24T01:00:00Z" }, "2026-07-01T00:00:00Z").toISOString(), "2027-08-25T01:00:00.000Z");
});

test("deleted draft media is recorded with one durable due date", async () => {
  let write;
  const id = "a".repeat(24);
  await rememberDeletedDraftMedia({ _id: id, folder: "drafts/old" }, {
    now: "2026-10-05T12:00:00Z",
    DraftModel: { updateOne: async (...args) => { write = args; } },
  });
  assert.equal(write[0]._id, id);
  assert.equal(write[0].deletedAt, null);
  assert.equal(write[1].$set.mediaCleanupDueAt.toISOString(), "2027-08-25T01:00:00.000Z");
  assert.equal(write[1].$set.deletedAt.toISOString(), "2026-10-05T12:00:00.000Z");
});

function setup({ eventDate = "2026-08-01T12:00:00Z", activeDraft = false, deletedDraft = false, fail = false } = {}) {
  const dueAt = new Date("2026-08-25T01:00:00Z");
  const event = { _id: "a".repeat(24), folder: "groningen-event", date: new Date(eventDate), dueAt,
    mediaCleanupDueAt: dueAt, poster: "https://example.test/poster.jpg" };
  const updates = [], calls = [];
  const EventModel = {
    find: filter => chain(filter.mediaCleanupDueAt === null ? [] : filter.folder === event.folder ? [event] : [event]),
    updateOne: async (...args) => { updates.push(["eventOne", ...args]); },
    updateMany: async (...args) => { updates.push(["events", ...args]); },
  };
  const DraftModel = {
    find: () => chain(deletedDraft ? [{ _id: "b".repeat(24), folder: event.folder, mediaCleanupDueAt: dueAt }] : []),
    exists: async () => activeDraft,
    updateMany: async (...args) => { updates.push(["drafts", ...args]); },
    deleteMany: async (...args) => { updates.push(["draftsDeleted", ...args]); },
  };
  const removeFolder = async folder => { calls.push(folder); if (fail) throw new Error("Cloudinary unavailable"); };
  const removeArchivedPoster = async value => { calls.push(`poster:${value._id}`); };
  const lease = async (_key, run) => run({ assertOwned: async () => {} });
  const run = () => runEventMediaCleanup({ now: new Date("2026-08-26T12:00:00Z"),
    EventModel, DraftModel, removeFolder, removeArchivedPoster, lease });
  return { run, updates, calls };
}

test("due folder is deleted and completion is persisted", async () => {
  const h = setup();
  const result = await h.run();
  assert.deepEqual(result, { scheduled: 0, cleared: 1, deferred: 0, failed: 0 });
  assert.deepEqual(h.calls, ["groningen-event", `poster:${"a".repeat(24)}`]);
  assert.equal(h.updates.find(update => update[0] === "events")[2].$set.mediaCleanupAt.toISOString(), "2026-08-26T12:00:00.000Z");
  assert.equal(h.updates.find(update => update[0] === "draftsDeleted")[1].folder, "groningen-event");
});

test("event too recent at the August 25 cutoff defers its shared folder", async () => {
  const h = setup({ eventDate: "2026-08-24T12:00:00Z" });
  const result = await h.run();
  assert.equal(result.deferred, 1);
  assert.deepEqual(h.calls, []);
  assert.equal(h.updates.find(update => update[0] === "events")[2].$set.mediaCleanupDueAt.toISOString(), "2027-08-25T01:00:00.000Z");
});

test("a live draft blocks folder deletion", async () => {
  const h = setup({ activeDraft: true });
  assert.equal((await h.run()).deferred, 1);
  assert.deepEqual(h.calls, []);
});

test("a deleted draft is removed after its shared folder is cleared", async () => {
  const h = setup({ deletedDraft: true });
  assert.equal((await h.run()).cleared, 1);
  assert.deepEqual(h.updates.find(update => update[0] === "draftsDeleted")[1],
    { folder: "groningen-event", deletedAt: { $ne: null } });
});

test("Cloudinary failures leave the folder due and schedule a retry", async () => {
  const h = setup({ fail: true });
  assert.equal((await h.run()).failed, 1);
  assert.equal(h.updates.find(update => update[0] === "events")[2].$set.mediaCleanupRetryAt.toISOString(), "2026-08-26T13:00:00.000Z");
});

test("annual worker is enabled on production PM2 worker zero", () => {
  assert.equal(getEventMediaCleanupConfig({ NODE_ENV: "production", NODE_APP_INSTANCE: "0" }).enabled, true);
  assert.equal(getEventMediaCleanupConfig({ NODE_ENV: "production", NODE_APP_INSTANCE: "1" }).enabled, false);
  assert.equal(getEventMediaCleanupConfig({ NODE_ENV: "development" }).enabled, false);
});

test("annual cleanup runs once for the academic-year cutoff and persists completion", async () => {
  let now = new Date("2026-08-25T00:59:59Z"), marker = false, runs = 0;
  const job = createAnnualEventMediaCleanupJob({ now: () => now,
    getMarker: async () => marker, setMarker: async () => { marker = true; },
    sweep: async ({ cutoff }) => {
      runs++;
      assert.equal(cutoff.toISOString(), "2026-08-25T01:00:00.000Z");
      return { cleared: 2, failed: 0, pendingRetry: 0 };
    } });
  assert.deepEqual(await job(), { skipped: true });
  now = new Date("2026-08-25T01:00:00Z");
  assert.equal((await job()).cleared, 2);
  assert.deepEqual(await job(), { skipped: true });
  assert.equal(runs, 1);
});

test("annual sweep drains all batches and leaves failed folders for bounded retries", async () => {
  let calls = 0;
  const model = { countDocuments: async () => 0 };
  const result = await runAnnualEventMediaCleanup({ cutoff: new Date("2026-08-25T01:00:00Z"),
    EventModel: model, DraftModel: model, run: async () => ++calls < 3
      ? { scheduled: 25, cleared: 25, deferred: 0, failed: 0 }
      : { scheduled: 0, cleared: 0, deferred: 0, failed: 0 } });
  assert.equal(calls, 3);
  assert.equal(result.cleared, 50);
  let marker = false;
  const job = createAnnualEventMediaCleanupJob({ now: () => new Date("2026-08-26T12:00:00Z"),
    getMarker: async () => marker, setMarker: async () => { marker = true; },
    sweep: async () => ({ failed: 1 }) });
  assert.equal((await job()).failed, 1);
  assert.equal(marker, false);
});
