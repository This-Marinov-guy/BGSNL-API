import assert from "node:assert/strict";
import test from "node:test";
import EventDraft from "../models/EventDraft.js";
import {
  createEventDraftCleanupJob, deleteExpiredEventDrafts,
  getEventDraftCleanupConfig, startEventDraftCleanupWorker,
} from "../services/background-services/event-draft-cleanup.js";

const settle = () => new Promise(resolve => setImmediate(resolve));

test("cleanup is scoped to draft status in the dedicated collection with a strict 30-day cutoff", async () => {
  let query;
  const result = await deleteExpiredEventDrafts({
    now: new Date("2026-10-15T01:00:00Z"),
    DraftModel: { deleteMany: async value => { query = value; return { deletedCount: 4 }; } },
  });
  const cutoff = new Date("2026-09-15T01:00:00Z");
  assert.equal(EventDraft.collection.collectionName, "eventDrafts");
  assert.deepEqual(query, { status: "draft", $or: [
    { createdAt: { $type: "date", $lt: cutoff } },
    { createdAt: null, "metadata.createdAt": { $type: "date", $lt: cutoff } },
  ] });
  assert.deepEqual(result, { deletedCount: 4, cutoff });
  assert(!JSON.stringify(query).includes("updatedAt"));
});

test("invalid clock values cannot issue a delete", async () => {
  await assert.rejects(deleteExpiredEventDrafts({ now: "invalid", DraftModel: {
    deleteMany() { assert.fail("Must not delete on an invalid clock"); },
  } }), /Invalid event draft cleanup time/);
});

test("scheduler defaults to production worker zero, with explicit on/off overrides", () => {
  for (const [env, enabled] of [
    [{ NODE_ENV: "production" }, true],
    [{ NODE_ENV: "development" }, false],
    [{ NODE_ENV: "production", EVENT_DRAFT_CLEANUP_ENABLED: "false" }, false],
    [{ NODE_ENV: "development", EVENT_DRAFT_CLEANUP_ENABLED: "true" }, true],
    [{ NODE_ENV: "production", NODE_APP_INSTANCE: "0" }, true],
    [{ NODE_ENV: "production", NODE_APP_INSTANCE: "1", EVENT_DRAFT_CLEANUP_ENABLED: "true" }, false],
  ]) assert.equal(getEventDraftCleanupConfig(env).enabled, enabled);
});

test("cleanup becomes due at 03:00 Amsterdam in summer and winter, once per day", async () => {
  for (const [before, due] of [
    ["2026-09-15T00:59:59Z", "2026-09-15T01:00:00Z"],
    ["2026-12-15T01:59:59Z", "2026-12-15T02:00:00Z"],
    ["2026-03-29T00:59:59Z", "2026-03-29T01:00:00Z"],
    ["2026-10-25T01:59:59Z", "2026-10-25T02:00:00Z"],
  ]) {
    let now = new Date(before), runs = 0;
    const job = createEventDraftCleanupJob({ now: () => now, cleanup: async () => { runs++; return { deletedCount: 1 }; } });
    assert.deepEqual(await job(), { skipped: true });
    now = new Date(due);
    assert.deepEqual(await job(), { deletedCount: 1 });
    assert.deepEqual(await job(), { skipped: true });
    assert.equal(runs, 1);
  }
});

test("a late startup catches up and the following calendar day runs again", async () => {
  let now = new Date("2026-09-15T18:00:00Z"), runs = 0;
  const job = createEventDraftCleanupJob({ now: () => now, cleanup: async () => { runs++; } });
  await job(); await job();
  now = new Date("2026-09-15T23:00:00Z"); // 01:00 the next local day
  await job();
  assert.equal(runs, 1);
  now = new Date("2026-09-16T01:00:00Z");
  await job();
  assert.equal(runs, 2);
});

test("a failed cleanup retries and only success completes the day", async () => {
  let attempts = 0;
  const job = createEventDraftCleanupJob({ now: () => new Date("2026-09-15T12:00:00Z"), cleanup: async () => {
    if (++attempts === 1) throw new Error("temporary database failure");
    return { deletedCount: 1 };
  } });
  await assert.rejects(job(), /temporary database failure/);
  assert.deepEqual(await job(), { deletedCount: 1 });
  assert.deepEqual(await job(), { skipped: true });
  assert.equal(attempts, 2);
});

test("disabled worker never schedules or deletes", async () => {
  const stop = startEventDraftCleanupWorker({ config: { enabled: false },
    schedule: () => assert.fail("Must not schedule"), run: () => assert.fail("Must not delete") });
  await stop();
});

test("worker prevents overlaps and shutdown waits for the active deletion", async () => {
  let tick, finish, runs = 0, cleared = false, stopped = false;
  const pending = new Promise(resolve => { finish = resolve; });
  const stop = startEventDraftCleanupWorker({ config: { enabled: true },
    schedule: (callback, interval) => { tick = callback; assert.equal(interval, 60000); return { unref() {} }; },
    unschedule: () => { cleared = true; },
    run: async () => { runs++; await pending; },
  });
  await settle(); tick(); tick(); await settle();
  assert.equal(runs, 1);
  const stopping = stop().then(() => { stopped = true; });
  await settle(); assert(cleared); assert.equal(stopped, false);
  tick(); finish(); await stopping; tick(); await settle();
  assert.equal(runs, 1); assert(stopped);
});

test("worker catches a synchronous failure and retries on the next tick", async () => {
  let tick, runs = 0, errors = 0;
  const stop = startEventDraftCleanupWorker({ config: { enabled: true },
    schedule: callback => { tick = callback; return { unref() {} }; }, unschedule() {},
    run: () => { if (++runs === 1) throw new Error("failure"); },
    onError: () => { errors++; },
  });
  await settle(); assert.equal(errors, 1);
  tick(); await settle(); assert.equal(runs, 2);
  await stop();
});
