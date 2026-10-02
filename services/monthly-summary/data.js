import { createHash } from "node:crypto";
import MonthlySummary, { MonthlySummaryDelivery } from "../../models/MonthlySummary.js";
import AlumniUser from "../../models/AlumniUser.js";
import Event from "../../models/Event.js";
import { loadWeeklyMembershipSummary } from "../background-services/weekly-membership-report.js";
import { eventPageUrl } from "../events/member-event-links.js";
import { isActiveSummaryAlumni, monthlyPeriod, normalizeSummaryEmail, safeHttpsUrl, validateNews } from "./policy.js";
import HttpError from "../../models/Http-error.js";

export const loadMonthlyDraft = async (month, { SummaryModel = MonthlySummary } = {}) =>
  await SummaryModel.findById(month).lean() || { _id: month, news: [], revision: 0 };

export async function loadMonthlySnapshot(month, { now = new Date(), EventModel = Event, loadCounts = loadWeeklyMembershipSummary, draft } = {}) {
  const period = monthlyPeriod(month, now);
  const selectedDraft = draft || await loadMonthlyDraft(month);
  if (selectedDraft.snapshot) return selectedDraft.snapshot;
  const actualDate = { $ifNull: ["$correctedDate", "$date"] };
  const [events, counts] = await Promise.all([
    EventModel.find({ hidden: { $ne: true }, status: { $nin: ["draft", "cancelled", "canceled"] },
      $expr: { $and: [{ $gte: [actualDate, period.periodStart] }, { $lt: [actualDate, period.cutoff] }] },
    }).select("_id title date correctedDate poster region slug").maxTimeMS(15000).lean(),
    loadCounts({ periodStart: period.periodStart, periodEnd: period.cutoff }),
  ]);
  return { month, label: period.label, cutoff: period.cutoff.toISOString(),
    members: counts.totals.members, alumni: counts.totals.alumni,
    news: validateNews(selectedDraft.news || []),
    events: events.map(event => ({ id: String(event._id), title: event.title,
      date: new Date(event.correctedDate || event.date).toISOString(), poster: safeHttpsUrl(event.poster), url: eventPageUrl(event),
    })).sort((left, right) => left.date.localeCompare(right.date)),
  };
}

export async function loadMonthlyRecipients({ now = new Date(), internalEmails = [], AlumniModel = AlumniUser } = {}) {
  const accounts = await AlumniModel.find({ status: "active", tier: { $gte: 1, $lte: 4 }, notificationTerms: true,
    $or: [{ expireDate: { $gt: now } }, { roles: "vip" }],
  }).select("_id email status tier expireDate roles subscription.id subscription.hasBenefits subscription.lockReason notificationTerms notificationTypeTerms").maxTimeMS(15000).lean();
  const emails = new Set(accounts.filter(account => isActiveSummaryAlumni(account, now)).map(account => normalizeSummaryEmail(account.email)));
  const alumniCount = emails.size;
  for (const value of internalEmails) { const email = normalizeSummaryEmail(value); if (email) emails.add(email); }
  return { emails: [...emails], alumniCount, internalCount: emails.size - alumniCount };
}

export async function saveMonthlyNews({ month, revision, news, userId }, { now = new Date(), SummaryModel = MonthlySummary } = {}) {
  const period = monthlyPeriod(month, now);
  if (+now >= +period.dueAt) throw new HttpError("This month's news is closed for sending. Choose a future month.", 409);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new HttpError("Reload this summary before saving.", 422);
  const cleaned = validateNews(news);
  try {
    const saved = await SummaryModel.findOneAndUpdate({ _id: month, revision, publishedAt: null }, {
      $set: { news: cleaned, updatedBy: userId }, $inc: { revision: 1 },
    }, { new: true, upsert: revision === 0, runValidators: true, setDefaultsOnInsert: true }).lean();
    if (!saved) throw new HttpError("This summary changed or is already being sent. Reload it before editing.", 409);
    return saved;
  } catch (error) {
    if (error?.code === 11000) throw new HttpError("Another editor saved this month. Reload before saving your changes.", 409);
    throw error;
  }
}

export async function freezeMonthlySnapshot(month, snapshot, { now = new Date(), SummaryModel = MonthlySummary } = {}) {
  try {
    // Take news from the document in the same atomic update. An editor saving
    // just before the cutoff must not be overwritten by an earlier draft read.
    const frozen = await SummaryModel.findOneAndUpdate({ _id: month, publishedAt: null }, [
      { $set: { publishedAt: now, snapshot: { $literal: snapshot },
        news: { $ifNull: ["$news", []] }, revision: { $ifNull: ["$revision", 0] },
        createdAt: { $ifNull: ["$createdAt", now] }, updatedAt: now } },
      { $set: { "snapshot.news": "$news" } },
    ], { new: true, upsert: true }).lean();
    return frozen.snapshot;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await SummaryModel.findById(month).lean();
    if (!existing?.snapshot) throw error;
    return existing.snapshot;
  }
}

export const monthlyDeliveryId = (month, email) => `${month}:${createHash("sha256").update(normalizeSummaryEmail(email)).digest("hex")}`;
export async function claimMonthlyDelivery(month, email, { now = new Date(), DeliveryModel = MonthlySummaryDelivery } = {}) {
  const _id = monthlyDeliveryId(month, email);
  try { await DeliveryModel.create({ _id, month, status: "attempted", attemptedAt: now }); return _id; }
  catch (error) { if (error?.code === 11000) return null; throw error; }
}
export const finishMonthlyDelivery = (_id, status, { now = new Date(), DeliveryModel = MonthlySummaryDelivery } = {}) =>
  DeliveryModel.updateOne({ _id }, { $set: { status, finishedAt: now } });
