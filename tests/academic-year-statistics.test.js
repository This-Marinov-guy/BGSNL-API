import assert from "node:assert/strict";
import test from "node:test";
import { startAcademicYearStatisticsWorker } from "../services/background-services/academic-year-statistics.js";

const flush = () => new Promise(resolve => setImmediate(resolve));

test("worker seeds on startup and again at Amsterdam midnight on 25 August", async () => {
  let current = new Date("2027-08-24T21:59:58Z");
  const initialized = [];
  const scheduled = [];
  const cancelled = [];
  const stop = startAcademicYearStatisticsWorker({
    enabled: true,
    now: () => current,
    initialize: async date => initialized.push(date.toISOString()),
    observe: (_source, _name, work) => work(),
    schedule: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    cancel: timer => cancelled.push(timer),
  });
  await flush();
  assert.deepEqual(initialized, ["2027-08-24T21:59:58.000Z"]);
  assert.equal(scheduled[0].delay, 2000);
  current = new Date("2027-08-24T22:00:00Z");
  scheduled[0].callback();
  await flush();
  assert.deepEqual(initialized, ["2027-08-24T21:59:58.000Z", "2027-08-24T22:00:00.000Z"]);
  await stop();
  assert.equal(cancelled[0], scheduled[1]);
  scheduled[1].callback();
  assert.equal(initialized.length, 2);
});

test("startup after rollover seeds the current period and a failed attempt retries", async () => {
  const current = new Date("2027-08-25T09:00:00Z");
  const calls = [];
  const scheduled = [];
  const errors = [];
  const stop = startAcademicYearStatisticsWorker({
    enabled: true,
    now: () => current,
    initialize: async date => {
      calls.push(date.toISOString());
      if (calls.length === 1) throw new Error("temporary database failure");
    },
    observe: (_source, _name, work) => work(),
    schedule: (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; },
    cancel: () => {},
    onError: error => errors.push(error.message),
  });
  await flush();
  assert.deepEqual(errors, ["temporary database failure"]);
  assert.equal(scheduled[0].delay, 3_600_000);
  scheduled[0].callback();
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(scheduled[1].delay, 2_147_483_647);
  await stop();
});
