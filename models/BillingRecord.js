import mongoose from "mongoose";

// Durable leases, checkout reservations and delivery receipts. No TTL on
// receipts: an old replay must not recreate a subscription or send more mail.
const schema = new mongoose.Schema({
  _id: String, owner: String, leaseUntil: Date, completedAt: Date,
  data: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
schema.index({ completedAt: 1, updatedAt: 1 }, { partialFilterExpression: { "data.sessionId": { $exists: true } } });
export default mongoose.model("BillingRecord", schema);
