import { loadMonthlyDraft, loadMonthlyRecipients, loadMonthlySnapshot, saveMonthlyNews } from "../services/monthly-summary/data.js";
import { buildMonthlySummaryEmail } from "../services/monthly-summary/email.js";
import { monthlyPeriod } from "../services/monthly-summary/policy.js";
import { monthlySummaryConfig } from "../services/monthly-summary/worker.js";

export const createMonthlySummaryControllers = ({
  loadDraft = loadMonthlyDraft, loadSnapshot = loadMonthlySnapshot,
  loadRecipients = loadMonthlyRecipients, saveNews = saveMonthlyNews,
  now = () => new Date(), getConfig = monthlySummaryConfig,
} = {}) => ({
  get: async (req, res, next) => {
    try {
      const current = now();
      const period = monthlyPeriod(req.params.month, current);
      const config = getConfig();
      const [draft, recipients] = await Promise.all([
        loadDraft(period.month), loadRecipients({ now: current, internalEmails: config.internalEmails }),
      ]);
      const snapshot = await loadSnapshot(period.month, { now: current, draft });
      const email = buildMonthlySummaryEmail(snapshot);
      return res.json({ month: period.month, label: period.label, dueAt: period.dueAt, timeZone: period.timeZone,
        editable: !draft.publishedAt && +current < +period.dueAt,
        publishedAt: draft.publishedAt || null, revision: draft.revision, news: draft.news,
        recipients: { total: recipients.emails.length, alumni: recipients.alumniCount, internal: recipients.internalCount },
        counts: { members: snapshot.members, alumni: snapshot.alumni, events: snapshot.events.length },
        preview: { subject: email.subject, html: email.html },
      });
    } catch (error) { return next(error); }
  },
  save: async (req, res, next) => {
    try {
      const saved = await saveNews({ month: req.params.month, revision: req.body?.revision,
        news: req.body?.news, userId: req.user.userId }, { now: now() });
      return res.json({ month: saved._id, revision: saved.revision, news: saved.news });
    } catch (error) { return next(error); }
  },
});
export const monthlySummaryControllers = createMonthlySummaryControllers();
