import mongoose from "mongoose";
import Event from "../../models/Event.js";
import Campaign, { EventEmailDelivery } from "../../models/EventEmailCampaign.js";
import HttpError from "../../models/Http-error.js";
import { ALL_EVENT_REGIONS_ACCESS, EVENT_MANAGEMENT_ACCESS } from "../../util/config/defines.js";
import { createEventCampaignService } from "../../services/events/event-campaigns.js";
import { eventCampaignsEnabled } from "../../services/events/event-campaign-worker.js";

export function createEventCampaignHandlers({ EventModel = Event, CampaignModel = Campaign, DeliveryModel = EventEmailDelivery,
  service = createEventCampaignService(), enabled = eventCampaignsEnabled } = {}) {
  const handle = action => async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.eventId)) throw new HttpError("Invalid event ID.", 400);
      const roles = req.user?.roles || [];
      if (!roles.some(role => EVENT_MANAGEMENT_ACCESS.includes(role))) throw new HttpError("No access to event campaigns.", 403);
      const event = await EventModel.findById(req.params.eventId).select("region").lean();
      if (!event) throw new HttpError("This event no longer exists.", 404);
      if (!roles.some(role => ALL_EVENT_REGIONS_ACCESS.includes(role)) && (!req.user.region || req.user.region !== event.region || event.region === "netherlands")) throw new HttpError("You can only send campaigns for your region's events.", 403);
      res.set("Cache-Control", "private, no-store");
      await action(req, res);
    } catch (error) { next(error instanceof HttpError ? error : new HttpError("The campaign request could not be completed. Please review and try again.", 503)); }
  };
  return {
    preview: handle(async (req, res) => res.json({ status: true, preview: await service.preview(req.params.eventId, req.body || {}, req.user.userId), sendingEnabled: enabled() })),
    confirm: handle(async (req, res) => {
      if (!enabled()) throw new HttpError("Campaign sending is disabled in this environment. You can still preview emails.", 409);
      const campaign = await service.confirm(req.params.eventId, req.body || {}, req.user.userId);
      res.status(202).json({ status: true, campaign: { id: campaign._id, status: campaign.status, total: campaign.total } });
    }),
    status: handle(async (req, res) => {
      const campaign = await CampaignModel.findOne({ _id: req.params.campaignId, eventId: req.params.eventId }).select("status total kind audience createdAt completedAt").lean();
      if (!campaign) throw new HttpError("Campaign not found.", 404);
      const counts = await DeliveryModel.aggregate([{ $match: { campaignId: campaign._id } }, { $group: { _id: "$status", count: { $sum: 1 } } }]);
      res.json({ status: true, campaign: { ...campaign, counts: Object.fromEntries(counts.map(row => [row._id, row.count])) } });
    }),
  };
}
export const eventCampaignHandlers = createEventCampaignHandlers();
