import assert from "node:assert/strict";
import test from "node:test";
import { isBusinessHour, nextBusinessHourlyCheckAt, nextDailyCheckAt,
  startBusinessHourlyCheck, startDailyCheck } from "../services/jobs/calendar-check.js";

test("daily checks stay at 10:00 Amsterdam across daylight saving changes", () => {
  assert.equal(nextDailyCheckAt(new Date("2026-03-28T10:00:00Z")).toISOString(), "2026-03-29T08:00:00.000Z");
  assert.equal(nextDailyCheckAt(new Date("2026-10-24T10:00:00Z")).toISOString(), "2026-10-25T09:00:00.000Z");
});

test("daily schedule runs once after a late startup and arms the next day", () => {
  let current = new Date("2026-10-24T09:30:00Z");
  let runs = 0;
  const scheduled = [];
  const stop = startDailyCheck(() => { runs++; }, { now: () => current,
    schedule: (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; },
    cancel: () => {} });
  assert.equal(runs, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 23.5 * 3600_000);
  current = new Date("2026-10-25T09:00:00Z");
  scheduled[0].callback();
  assert.equal(runs, 2);
  stop();
});

test("business-hour retries use weekday 09:00-17:00 Amsterdam slots", () => {
  assert.equal(isBusinessHour(new Date("2026-10-24T10:00:00Z")), false);
  assert.equal(isBusinessHour(new Date("2026-10-26T08:30:00Z")), true);
  assert.equal(isBusinessHour(new Date("2026-10-26T16:00:00Z")), false);
  assert.equal(nextBusinessHourlyCheckAt(new Date("2026-10-23T14:30:00Z")).toISOString(), "2026-10-26T08:00:00.000Z");
  assert.equal(nextBusinessHourlyCheckAt(new Date("2026-10-26T08:30:00Z")).toISOString(), "2026-10-26T09:00:00.000Z");
});

test("business-hour scheduler waits through the weekend", () => {
  let current = new Date("2026-10-24T10:00:00Z");
  let runs = 0;
  const scheduled = [];
  const stop = startBusinessHourlyCheck(() => { runs++; }, { now: () => current,
    schedule: (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; },
    cancel: () => {} });
  assert.equal(runs, 0);
  assert.equal(scheduled[0].delay, new Date("2026-10-26T08:00:00Z") - current);
  current = new Date("2026-10-26T08:00:00Z");
  scheduled[0].callback();
  assert.equal(runs, 1);
  assert.equal(scheduled[1].delay, 3600_000);
  stop();
});
