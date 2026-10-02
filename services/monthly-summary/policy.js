import moment from "moment-timezone";
import HttpError from "../../models/Http-error.js";

export const SUMMARY_TIME_ZONE = "Europe/Amsterdam";
export const monthKey = (now = new Date()) => moment(now).tz(SUMMARY_TIME_ZONE).format("YYYY-MM");
export function monthlyPeriod(month, now = new Date()) {
  if (typeof month !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new HttpError("Choose a valid month (YYYY-MM).", 422);
  }
  const start = moment.tz(`${month}-01`, "YYYY-MM-DD", true, SUMMARY_TIME_ZONE);
  const end = start.clone().add(1, "month");
  const due = end.clone().subtract(1, "minute");
  return { month, label: start.format("MMMM YYYY"), periodStart: start.toDate(), periodEnd: end.toDate(),
    dueAt: due.toDate(), cutoff: new Date(Math.min(+now, +due)), timeZone: SUMMARY_TIME_ZONE };
}
export function nextMonthlySummaryTime(now = new Date()) {
  const period = monthlyPeriod(monthKey(now), now);
  return +period.dueAt > +now ? period.dueAt
    : monthlyPeriod(moment(now).tz(SUMMARY_TIME_ZONE).add(1, "month").format("YYYY-MM"), now).dueAt;
}
export const summaryIsDue = (now) => {
  const period = monthlyPeriod(monthKey(now), now);
  return +now >= +period.dueAt && +now < +period.periodEnd;
};
export const safeHttpsUrl = (value) => {
  if (typeof value !== "string" || value.length > 2048) return "";
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : ""; }
  catch { return ""; }
};
export function validateNews(value) {
  if (!Array.isArray(value) || value.length > 10) throw new HttpError("Add up to 10 news items.", 422);
  return value.map((item, index) => {
    const title = typeof item?.title === "string" ? item.title.trim() : "";
    const body = typeof item?.body === "string" ? item.body.trim() : "";
    const url = typeof item?.url === "string" ? item.url.trim() : "";
    if (!title || title.length > 160 || !body || body.length > 2000) {
      throw new HttpError(`News item ${index + 1} needs a title (up to 160 characters) and text (up to 2,000 characters).`, 422);
    }
    if (url && !safeHttpsUrl(url)) throw new HttpError(`News item ${index + 1} needs a valid HTTPS link, or leave it empty.`, 422);
    return { title, body, url: url ? safeHttpsUrl(url) : "" };
  });
}
export const normalizeSummaryEmail = value => {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : "";
};
export function isActiveSummaryAlumni(account, now = new Date()) {
  const subscription = account?.subscription;
  return account?.status === "active" && account.tier >= 1 && account.tier <= 4 &&
    account.notificationTerms === true &&
    (!account.notificationTypeTerms || /email|any/i.test(account.notificationTypeTerms)) &&
    (new Date(account.expireDate) > now || account.roles?.includes("vip")) &&
    (!subscription?.id || (subscription.hasBenefits === true && !subscription.lockReason)) &&
    !!normalizeSummaryEmail(account.email);
}
