import mongoose from "mongoose";
import Event from "../../models/Event.js";
import Campaign from "../../models/EventEmailCampaign.js";
import HttpError from "../../models/Http-error.js";
import { EVENT_MANAGEMENT_ACCESS } from "../../util/config/defines.js";
import { createEventCampaignService } from "../../services/events/event-campaigns.js";
import { canAccessRegion } from "../../middleware/authorization.js";
import { eventCampaignsEnabled } from "../../services/events/event-campaign-worker.js";
import { verifyGuestSignupToken } from "../../services/events/guest-signup-prefill.js";
import { acceptedMailCount } from "../../services/events/event-mail-history.js";

export function createEventCampaignHandlers({ EventModel = Event, CampaignModel = Campaign,
  service = createEventCampaignService(), enabled = eventCampaignsEnabled } = {}) {
  const handle = action => async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.eventId)) throw new HttpError("Invalid event ID.", 400);
      const roles = req.user?.roles || [];
      if (!roles.some(role => EVENT_MANAGEMENT_ACCESS.includes(role))) throw new HttpError("No access to event campaigns.", 403);
      const event = await EventModel.findById(req.params.eventId).select("region").lean();
      if (!event) throw new HttpError("This event no longer exists.", 404);
      if (!canAccessRegion(req, "event", event.region)) throw new HttpError("You can only send campaigns for your region's events.", 403);
      res.set("Cache-Control", "private, no-store");
      await action(req, res);
    } catch (error) { next(error instanceof HttpError ? error : new HttpError("The campaign request could not be completed. Please review and try again.", 503)); }
  };
  return {
    preview: handle(async (req, res) => res.json({ status: true, preview: await service.preview(req.params.eventId, req.body || {}, req.user.userId), sendingEnabled: enabled() })),
    history: handle(async (req, res) => {
      const event = await EventModel.findById(req.params.eventId).select("mailHistory mailAcceptedTotal").lean();
      if (!event) throw new HttpError("This event no longer exists.", 404);
      const active = await CampaignModel.find({ eventId: req.params.eventId, status: { $in: ["queued", "sending"] } })
        .select("_id kind audience status createdBy total createdAt").sort({ createdAt: -1 }).limit(20).lean();
      const summaries = event.mailHistory || [];
      const recorded = new Set(summaries.map(item => item.campaignId));
      const history = [...summaries, ...active.filter(campaign => !recorded.has(campaign._id)).map(campaign => ({
        campaignId: campaign._id, kind: campaign.kind, audience: campaign.audience, status: campaign.status,
        createdBy: campaign.createdBy, total: campaign.total, createdAt: campaign.createdAt,
      }))].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 20).map(({ createdBy, ...entry }) => ({
        ...entry, source: createdBy === "scheduler" || createdBy === "publication" ? "automatic" : "manual",
      }));
      res.json({ status: true, history, sentCount: Math.max(event.mailAcceptedTotal || 0, acceptedMailCount(summaries)) });
    }),
    confirm: handle(async (req, res) => {
      if (!enabled()) throw new HttpError("Campaign sending is disabled in this environment. You can still preview emails.", 409);
      const campaign = await service.confirm(req.params.eventId, req.body || {}, req.user.userId);
      res.status(202).json({ status: true, campaign: { id: campaign._id, kind: campaign.kind, audience: campaign.audience, status: campaign.status, total: campaign.total } });
    }),
    status: handle(async (req, res) => {
      const campaign = await CampaignModel.findOne({ _id: req.params.campaignId, eventId: req.params.eventId }).select("status total kind audience createdAt completedAt accepted skipped failed cursor").lean();
      if (!campaign) throw new HttpError("Campaign not found.", 404);
      const event = await EventModel.findById(req.params.eventId).select("mailHistory").lean();
      const history = event?.mailHistory?.find(entry => entry.campaignId === campaign._id);
      const terminal = ["completed", "completed-with-errors", "stopped"].includes(campaign.status);
      res.json({ status: true, campaign: { ...campaign, counts: { accepted: campaign.accepted ?? history?.accepted ?? 0,
        skipped: campaign.skipped ?? history?.skipped ?? 0, failed: campaign.failed ?? history?.failed ?? 0,
        pending: terminal ? 0 : Math.max(0, campaign.total - (campaign.cursor || 0)) } } });
    }),
  };
}
export const eventCampaignHandlers = createEventCampaignHandlers();

export function guestSignupPrefill(req, res, next) {
  try {
    res.set("Cache-Control", "private, no-store");
    return res.json({ prefill: verifyGuestSignupToken(req.query?.token) });
  } catch (error) { return next(error instanceof HttpError ? error : new HttpError("This signup link could not be opened. Enter your details to continue.", 503)); }
}
