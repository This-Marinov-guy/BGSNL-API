import mongoose from "mongoose";

const monitoringJobSchema = new mongoose.Schema({
  source: { type: String, required: true, enum: ["scheduler", "mailer", "sheets-inline"] },
  name: { type: String, required: true, maxlength: 50 },
  status: { type: String, required: true, enum: ["pending", "completed", "failed"] },
  attempts: { type: Number, default: 0 },
  errorName: { type: String, maxlength: 80 },
  createdAt: { type: Date, default: Date.now },
  activityAt: { type: Date, default: Date.now },
  startedAt: Date,
  finishedAt: Date,
  expiresAt: { type: Date, required: true },
}, { versionKey: false });

monitoringJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
monitoringJobSchema.index({ status: 1, activityAt: -1 });

export default mongoose.models.MonitoringJob || mongoose.model("MonitoringJob", monitoringJobSchema);
