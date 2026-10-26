import test from "node:test";
import assert from "node:assert/strict";
import { archiveExpiredEventsSweep, createEventArchiveJob, eventArchiveEnabled, startEventArchiveWorker } from "../services/events/event-archive-worker.js";

test("archive sweep uses the three-day cutoff and continues after an event fails", async () => {
  const now = new Date("2026-10-24T12:00:00.000Z");
  const ids = ["first", "broken", "last"];
  let filter;
  const EventModel = { find(query) {
    filter = query;
    return { select(fields) {
      assert.equal(fields, "_id");
      return { cursor: async function* () { for (const _id of ids) yield { _id }; } };
    } };
  } };
  const calls = [], errors = [];
  const result = await archiveExpiredEventsSweep({ now, EventModel,
    archive: async (id, { cutoff }) => {
      calls.push([id, cutoff.toISOString()]);
      if (id === "broken") throw new Error("storage unavailable");
      return { _id: id };
    },
    onEventError: error => errors.push(error.message),
  });
  assert.deepEqual(calls, ids.map(id => [id, "2026-10-21T12:00:00.000Z"]));
  assert.deepEqual(filter.$or[1], { status: "archived", archiveCleanupPending: true });
  assert.deepEqual(errors, ["storage unavailable"]);
  assert.deepEqual(result, { archived: 2, failed: 1, skipped: false });
});

test("daily archive runs at 03:15 UTC, catches up after startup, and retries failures", async () => {
  let time = new Date("2026-10-24T03:14:00.000Z");
  const calls = [];
  const job = createEventArchiveJob({ now: () => time, sweep: async ({ now }) => {
    calls.push(now.toISOString());
    return { archived: 1, failed: calls.length === 1 ? 1 : 0 };
  } });
  assert.deepEqual(await job(), { skipped: true });
  time = new Date("2026-10-24T03:15:00.000Z");
  assert.equal((await job()).failed, 1);
  assert.equal((await job()).failed, 0);
  assert.deepEqual(await job(), { skipped: true });
  time = new Date("2026-10-25T12:00:00.000Z");
  assert.equal((await job()).failed, 0);
  assert.deepEqual(calls, ["2026-10-24T03:15:00.000Z", "2026-10-24T03:15:00.000Z", "2026-10-25T12:00:00.000Z"]);
});

test("archive worker runs on startup, prevents overlap, and stops cleanly", async () => {
  let tick, resolveFirst, calls = 0;
  const stop = startEventArchiveWorker({ enabled: true,
    run: () => { calls++; return calls === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve({ archived: 0, failed: 0 }); },
    schedule: callback => { tick = callback; return { unref() {} }; },
    unschedule: () => {},
    observe: (_source, _name, run) => run(),
  });
  assert.equal(calls, 1);
  tick();
  assert.equal(calls, 1);
  resolveFirst({ archived: 1, failed: 0 });
  await new Promise(resolve => setImmediate(resolve));
  tick();
  assert.equal(calls, 2);
  await stop();
  tick();
  assert.equal(calls, 2);
});

test("archive worker retries a failed sweep on the next tick", async () => {
  let tick, calls = 0;
  const errors = [];
  const stop = startEventArchiveWorker({ enabled: true,
    run: async () => { if (++calls === 1) throw new Error("database unavailable"); return { archived: 1, failed: 0 }; },
    schedule: callback => { tick = callback; return { unref() {} }; },
    unschedule: () => {},
    observe: (_source, _name, run) => run(),
    onError: error => errors.push(error.message),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ["database unavailable"]);
  tick();
  await stop();
  assert.equal(calls, 2);
});

test("archive worker runs only in production on the primary API process", async () => {
  assert.equal(eventArchiveEnabled({ NODE_ENV: "production", NODE_APP_INSTANCE: "0" }), true);
  assert.equal(eventArchiveEnabled({ NODE_ENV: "production", NODE_APP_INSTANCE: "1" }), false);
  assert.equal(eventArchiveEnabled({ NODE_ENV: "production", EVENT_ARCHIVE_ENABLED: "false" }), false);
  assert.equal(eventArchiveEnabled({ NODE_ENV: "development", EVENT_ARCHIVE_ENABLED: "true" }), true);
  assert.equal(eventArchiveEnabled({ NODE_ENV: "development" }), false);
});
