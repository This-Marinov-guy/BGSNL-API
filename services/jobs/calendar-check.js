import moment from "moment-timezone";

export const DAILY_CHECK_TIME_ZONE = "Europe/Amsterdam";
export const DAILY_CHECK_HOUR = 10;
export const BUSINESS_HOURS_START = 9;
export const BUSINESS_HOURS_END = 17;

export function nextDailyCheckAt(now = new Date(), { timeZone = DAILY_CHECK_TIME_ZONE,
  hour = DAILY_CHECK_HOUR } = {}) {
  const local = moment(now).tz(timeZone);
  if (!local.isValid()) throw new Error("Invalid daily check time");
  const due = local.clone().startOf("day").hour(hour);
  if (!due.isAfter(local)) due.add(1, "day");
  return due.toDate();
}

export function startDailyCheck(tick, { now = () => new Date(), timeZone = DAILY_CHECK_TIME_ZONE,
  hour = DAILY_CHECK_HOUR, intervalMs, schedule = setTimeout, cancel = clearTimeout,
  scheduleInterval = setInterval, cancelInterval = clearInterval } = {}) {
  let stopped = false;
  let timer;
  const run = () => {
    if (stopped) return undefined;
    try { return tick(); }
    finally { if (intervalMs == null) arm(); }
  };
  const arm = () => {
    if (stopped) return;
    const current = now();
    timer = schedule(run, Math.max(1, nextDailyCheckAt(current, { timeZone, hour }) - current));
    timer.unref?.();
  };
  if (intervalMs != null) {
    timer = scheduleInterval(run, intervalMs);
    timer.unref?.();
    run();
  } else {
    const local = moment(now()).tz(timeZone);
    if (!local.isValid()) throw new Error("Invalid daily check time");
    if (local.hour() >= hour) run();
    else arm();
  }
  return () => {
    stopped = true;
    if (timer) (intervalMs == null ? cancel : cancelInterval)(timer);
  };
}

export function isBusinessHour(now = new Date(), { timeZone = DAILY_CHECK_TIME_ZONE,
  startHour = BUSINESS_HOURS_START, endHour = BUSINESS_HOURS_END } = {}) {
  const local = moment(now).tz(timeZone);
  if (!local.isValid()) throw new Error("Invalid business-hour check time");
  return local.isoWeekday() <= 5 && local.hour() >= startHour && local.hour() < endHour;
}

export function nextBusinessHourlyCheckAt(now = new Date(), { timeZone = DAILY_CHECK_TIME_ZONE,
  startHour = BUSINESS_HOURS_START, endHour = BUSINESS_HOURS_END } = {}) {
  const local = moment(now).tz(timeZone);
  if (!local.isValid()) throw new Error("Invalid business-hour check time");
  const due = local.clone().startOf("hour").add(1, "hour");
  while (due.isoWeekday() > 5 || due.hour() < startHour || due.hour() >= endHour) due.add(1, "hour");
  return due.toDate();
}

export function startBusinessHourlyCheck(tick, { now = () => new Date(),
  schedule = setTimeout, cancel = clearTimeout, timeZone = DAILY_CHECK_TIME_ZONE,
  startHour = BUSINESS_HOURS_START, endHour = BUSINESS_HOURS_END } = {}) {
  let stopped = false;
  let timer;
  const options = { timeZone, startHour, endHour };
  const arm = () => {
    if (stopped) return;
    const current = now();
    timer = schedule(run, Math.max(1, nextBusinessHourlyCheckAt(current, options) - current));
    timer.unref?.();
  };
  const run = () => {
    if (stopped) return;
    try { tick(); }
    finally { arm(); }
  };
  if (isBusinessHour(now(), options)) run();
  else arm();
  return () => { stopped = true; if (timer) cancel(timer); };
}
