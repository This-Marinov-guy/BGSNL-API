import mongoose from "mongoose";

// One durable receipt per reporting period and recipient. The sender claims a
// receipt before contacting the provider, preventing duplicate weekly emails
// across restarts and multiple API instances.
const schema = new mongoose.Schema({
  _id: String,
  reportKey: { type: String, required: true },
  receiver: { type: String, required: true, lowercase: true, trim: true },
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  attemptedAt: Date,
  completedAt: Date,
  lastDeliveryError: String,
}, { timestamps: true });

schema.index({ reportKey: 1, attemptedAt: 1 });

export default mongoose.model("WeeklyMembershipReportDelivery", schema);
