import mongoose from "mongoose";

const schema = new mongoose.Schema({
  _id: String, subscriptionId: { type: String, required: true }, stripeRegion: String,
  invoiceId: String, startedAt: Date, resolvedAt: Date,
  firstAttemptAt: Date, secondAttemptAt: Date, nextAttemptAt: Date,
  lastDeliveryError: String,
}, { timestamps: true });
schema.index({ resolvedAt: 1, nextAttemptAt: 1 });
schema.index({ subscriptionId: 1, stripeRegion: 1 }, { unique: true, partialFilterExpression: { resolvedAt: null } });
export default mongoose.model("BillingAttention", schema);
