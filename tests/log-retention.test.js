import test from "node:test";
import assert from "node:assert/strict";
import { createLogRetentionJob, runLogRetention } from "../services/background-services/log-retention.js";

test("log retention runs separately at 03:05 Amsterdam and keeps a 30-day cutoff", async () => {
  let now = new Date("2026-10-24T01:04:59Z"), runs = 0;
  const job = createLogRetentionJob({ now: () => now, cleanup: async () => { runs++; return { cleaned: true }; } });
  assert.deepEqual(await job(), { skipped: true });
  now = new Date("2026-10-24T01:05:00Z");
  assert.deepEqual(await job(), { cleaned: true });
  assert.deepEqual(await job(), { skipped: true });
  assert.equal(runs, 1);
});

test("log retention prunes expired monitoring history, migration journal and old queue results", async () => {
  const cutoff = new Date("2026-09-24T01:05:00Z");
  let historyFilter, alertFilter, journalTime;
  const queues = [];
  const queue = () => ({ clean: async (age, limit, status) => {
    queues.push({ age, limit, status });
    return [];
  } });
  const result = await runLogRetention({ now: new Date("2026-10-24T01:05:00Z"),
    model: { deleteMany: async filter => { historyFilter = filter; return { deletedCount: 3 }; } },
    failureModel: { deleteMany: async filter => { alertFilter = filter; return { deletedCount: 2 }; } },
    cleanJournal: async ({ now }) => { journalTime = now; return { runsDeleted: 1 }; },
    spreadsheetQueue: queue, marketingQueue: queue, revenueQueue: queue });
  assert.equal(journalTime.toISOString(), "2026-10-24T01:05:00.000Z");
  assert.equal(historyFilter.$or[1].activityAt.$lt.toISOString(), cutoff.toISOString());
  assert.equal(result.historyDeleted, 3);
  assert.equal(result.alertsDeleted, 2);
  assert.equal(alertFilter.alertedAt.$lt.toISOString(), cutoff.toISOString());
  assert.equal(queues.length, 6);
  assert(queues.every(row => row.age === 30 * 86400_000 && row.limit === 1000));
});
