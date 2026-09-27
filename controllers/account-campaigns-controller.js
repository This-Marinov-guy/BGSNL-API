import HttpError from "../models/Http-error.js";
import { CURRENT_ACCOUNT_FILTER } from "../util/subscriptions/policy.js";

export const getAccountCampaign = (req, res) => res.json({
  campaign: req.params.campaign,
  seen: (req.account.campaignsSeen || []).includes(req.params.campaign),
});

// Acknowledge dismissal once on the authenticated account.
export const markAccountCampaignSeen = async (req, res, next) => {
  try {
    const account = req.account;
    const result = await account.constructor.updateOne({
      _id: account._id,
      ...CURRENT_ACCOUNT_FILTER,
      campaignsSeen: { $ne: req.params.campaign },
    }, {
      $addToSet: { campaignsSeen: req.params.campaign },
    });
    return res.json({ campaign: req.params.campaign, shouldShow: result.modifiedCount === 1 });
  } catch {
    return next(new HttpError("Account announcements are temporarily unavailable.", 503));
  }
};
