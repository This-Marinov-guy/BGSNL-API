import moment from "moment-timezone";

// Calendar months are 1-based. The academic year is [25 August, next 25 August).
export const ACADEMIC_YEAR_DATES = Object.freeze({
  term1: Object.freeze({ month: 11, day: 15 }),
  term2: Object.freeze({ month: 2, day: 15 }),
  term3: Object.freeze({ month: 5, day: 15 }),
  term4: Object.freeze({ month: 7, day: 15 }),
  resetDate: Object.freeze({ month: 8, day: 25 }),
});
export const ACADEMIC_YEAR_START = ACADEMIC_YEAR_DATES.resetDate;
export const ACADEMIC_YEAR_TIME_ZONE = "Europe/Amsterdam";

export function academicYearRange(value = new Date()) {
  const local = moment(value).tz(ACADEMIC_YEAR_TIME_ZONE);
  if (!local.isValid()) throw new Error("Invalid academic year date");
  const start = moment.tz({ year: local.year(), month: ACADEMIC_YEAR_START.month - 1,
    day: ACADEMIC_YEAR_START.day, hour: 0, minute: 0, second: 0 }, ACADEMIC_YEAR_TIME_ZONE);
  if (local.isBefore(start)) start.subtract(1, "year");
  return { start: start.toDate(), end: start.clone().add(1, "year").toDate() };
}

export const academicYearStart = value => academicYearRange(value).start;
export const academicYearLabel = value => {
  const year = moment(academicYearStart(value)).tz(ACADEMIC_YEAR_TIME_ZONE).year();
  return `${year}-${year + 1}`;
};

export function academicYearSchedule(value = new Date()) {
  const startYear = moment(academicYearStart(value)).tz(ACADEMIC_YEAR_TIME_ZONE).year();
  const date = (key, year) => moment.tz({ year, month: ACADEMIC_YEAR_DATES[key].month - 1,
    day: ACADEMIC_YEAR_DATES[key].day, hour: 0, minute: 0, second: 0 }, ACADEMIC_YEAR_TIME_ZONE).toDate();
  return {
    academicYear: `${startYear}-${startYear + 1}`,
    term1: date("term1", startYear),
    term2: date("term2", startYear + 1),
    term3: date("term3", startYear + 1),
    term4: date("term4", startYear + 1),
    resetDate: date("resetDate", startYear + 1),
  };
}
