import { randomUUID } from "node:crypto";
import HttpError from "../../models/Http-error.js";
import { ACCESS_2, ACCESS_3, ACCESS_4, BILLING_LOCKED_STATUSES, BILLING_LOCK_EXEMPT } from "../../util/config/defines.js";
import { notifyAccessRequested } from "../background-services/internal-notifications.js";
import { consumeSupportLimit } from "../support/rate-limit.js";

const areas = {
  events: { title: "Events", roles: ACCESS_4 },
  internships: { title: "Internships", roles: ACCESS_2 },
  members: { title: "Members", roles: ACCESS_3 },
  support: { title: "Support tickets", roles: ["super_admin", "admin", "support"] },
  "event-analytics": { title: "Event analytics", roles: ACCESS_3 },
  "member-statistics": { title: "Member statistics", roles: ACCESS_3 },
};

export const createAccessRequestService = ({ notify = notifyAccessRequested, limit = consumeSupportLimit } = {}) => ({
  async request({ account, body }) {
    if (!account?.email || !(account.id || account._id)) throw new HttpError("Please login to request access", 401);
    const roles = account.roles || [];
    const statusOk = account.status === "active" || (BILLING_LOCKED_STATUSES.includes(account.status) && BILLING_LOCK_EXEMPT.some((role) => roles.includes(role)));
    if (!statusOk) throw new HttpError("Your account cannot request administration access", 403);
    if (!body || Object.keys(body).some((key) => key !== "accesses") || !Array.isArray(body.accesses) ||
        body.accesses.length < 1 || body.accesses.length > Object.keys(areas).length ||
        body.accesses.some((id) => typeof id !== "string" || !Object.hasOwn(areas, id)) ||
        new Set(body.accesses).size !== body.accesses.length) {
      throw new HttpError("Select valid administration areas", 422);
    }
    if (body.accesses.some((id) => areas[id].roles.some((role) => roles.includes(role)))) {
      throw new HttpError("You already have access to one of the selected areas", 422);
    }
    const accountId = String(account.id || account._id);
    try { await limit(`administration-access:${accountId}`, 3, 24 * 60 * 60 * 1000); }
    catch (error) {
      if (error.code === 429) throw new HttpError("Too many access requests. Please try again tomorrow.", 429);
      throw error;
    }
    const count = await notify({ id: randomUUID(), accountId, email: account.email,
      accesses: body.accesses.map((id) => areas[id].title), createdAt: new Date() });
    if (!count) throw new HttpError("Access requests are temporarily unavailable. Please contact the society.", 503);
    return { accepted: true };
  },
});
export const accessRequestService = createAccessRequestService();
