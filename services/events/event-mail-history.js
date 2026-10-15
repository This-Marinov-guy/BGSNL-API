// Store only campaign totals on the event. Domakin Mailer's sheet holds delivery outcomes.
export const acceptedMailCount = history => (history || []).reduce((total, entry) => total + Math.max(0, Number(entry.accepted) || 0), 0);

export async function recordEventMailHistory({ EventModel, campaign, status, completedAt, counts = {} }) {
  const accepted = counts.accepted || 0;
  const skipped = counts.skipped || 0;
  const failed = counts.failed || 0;
  const entry = {
    campaignId: campaign._id,
    kind: campaign.kind,
    audience: campaign.audience,
    status,
    createdBy: campaign.createdBy,
    total: campaign.total,
    accepted, skipped, failed,
    notSent: Math.max(0, (campaign.total || 0) - accepted - skipped - failed),
    createdAt: campaign.createdAt,
    completedAt,
  };
  // Older events predate the cumulative field. Initialize from their retained
  // summaries once, before atomically adding this campaign's accepted count.
  const event = await EventModel.findById(campaign.eventId).select("mailAcceptedTotal mailHistory").lean();
  const retainedCount = acceptedMailCount(event?.mailHistory);
  if (event && (event.mailAcceptedTotal == null || event.mailAcceptedTotal < retainedCount)) {
    await EventModel.updateOne({ _id: campaign.eventId, $or: [
      { mailAcceptedTotal: { $exists: false } }, { mailAcceptedTotal: { $lt: retainedCount } },
    ] }, { $set: { mailAcceptedTotal: retainedCount } });
  }
  await EventModel.updateOne(
    { _id: campaign.eventId, "mailHistory.campaignId": { $ne: campaign._id } },
    { $push: { mailHistory: { $each: [entry], $slice: -100 } }, $inc: { mailAcceptedTotal: accepted } },
  );
}
