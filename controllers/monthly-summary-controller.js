import { loadMonthlyRecipients, loadMonthlySnapshot } from "../services/monthly-summary/data.js";
import { buildMonthlySummaryEmail } from "../services/monthly-summary/email.js";
import { monthlyPeriod } from "../services/monthly-summary/policy.js";
import { monthlySummaryConfig } from "../services/monthly-summary/worker.js";

export const createMonthlySummaryControllers = ({
  loadSnapshot = loadMonthlySnapshot, loadRecipients = loadMonthlyRecipients,
  now = () => new Date(), getConfig = monthlySummaryConfig,
} = {}) => ({
  get: async (req, res, next) => {
    try {
      const current = now();
      const period = monthlyPeriod(req.params.month, current);
      const config = getConfig();
      const [snapshot, recipients] = await Promise.all([
        loadSnapshot(period.month, { now: current }), loadRecipients({ now: current, internalEmails: config.internalEmails }),
      ]);
      const email = buildMonthlySummaryEmail(snapshot);
      return res.json({ month: period.month, label: period.label, dueAt: period.dueAt, timeZone: period.timeZone,
        recipients: { total: recipients.emails.length, alumni: recipients.alumniCount, internal: recipients.internalCount },
        counts: { members: snapshot.members, alumni: snapshot.alumni, events: snapshot.events.length },
        preview: { subject: email.subject, html: email.html },
      });
    } catch (error) { return next(error); }
  },
});
export const monthlySummaryControllers = createMonthlySummaryControllers();
