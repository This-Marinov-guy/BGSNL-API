import mongoose from "mongoose";
const { Schema } = mongoose;
const campaign = new Schema({
  _id: String, key: { type: String, required: true, unique: true }, eventId: { type: Schema.Types.ObjectId, required: true },
  kind: String, audience: String, version: String, contentHash: String, promoCode: String, createdBy: String,
  status: { type: String, default: "queued" }, createdAt: { type: Date, default: Date.now }, completedAt: Date,
  // Snapshot only the approved audience; workers may remove recipients, never add.
  recipients: [{ _id: false, email: String, audience: String }],
  total: Number,
}, { collection: "eventEmailCampaigns", versionKey: false });
campaign.index({ status: 1, createdAt: 1 });
export default mongoose.model("EventEmailCampaign", campaign);

const delivery = new Schema({
  _id: String, campaignId: String, eventId: Schema.Types.ObjectId, kind: String, version: String,
  email: String, audience: String, operationId: String,
  status: { type: String, default: "pending" }, attempts: { type: Number, default: 0 },
  leaseUntil: Date, nextAttemptAt: Date, finishedAt: Date, reason: String,
  // Reuse the exact envelope and operation ID after uncertain delivery/timeouts.
  variables: Schema.Types.Mixed, bulk: Schema.Types.Mixed,
}, { collection: "eventEmailDeliveries", versionKey: false });
delivery.index({ campaignId: 1, status: 1 });
delivery.index({ eventId: 1, kind: 1, version: 1, email: 1 });
export const EventEmailDelivery = mongoose.model("EventEmailDelivery", delivery);
