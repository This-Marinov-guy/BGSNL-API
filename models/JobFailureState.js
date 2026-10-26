import mongoose from "mongoose";

const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  failures: { type: Number, default: 0 },
  source: String,
  name: String,
  haltedAt: Date,
  alertedAt: Date,
  alertLeaseUntil: Date,
  updatedAt: Date,
}, { versionKey: false });

schema.index({ haltedAt: 1, alertedAt: 1, alertLeaseUntil: 1 });
schema.index({ source: 1, alertedAt: 1 });

export default mongoose.models.JobFailureState || mongoose.model("JobFailureState", schema);
