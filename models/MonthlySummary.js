import mongoose from "mongoose";

const newsSchema = new mongoose.Schema({
  title: { type: String, required: true, maxlength: 160 },
  body: { type: String, required: true, maxlength: 2000 },
  url: { type: String, maxlength: 2048, default: "" },
}, { _id: false });
const schema = new mongoose.Schema({
  _id: { type: String, match: /^20\d{2}-(0[1-9]|1[0-2])$/ },
  news: { type: [newsSchema], default: [], validate: value => value.length <= 10 },
  revision: { type: Number, default: 0 },
  updatedBy: String,
  publishedAt: Date,
  snapshot: mongoose.Schema.Types.Mixed,
}, { collection: "monthlySummaries", timestamps: true, versionKey: false });
export default mongoose.model("MonthlySummary", schema);

const deliverySchema = new mongoose.Schema({
  _id: String, // month + SHA-256 of normalized email; one attempt across workers/restarts
  month: { type: String, required: true },
  status: { type: String, enum: ["attempted", "sent", "uncertain"], required: true },
  attemptedAt: { type: Date, required: true },
  finishedAt: Date,
}, { collection: "monthlySummaryDeliveries", versionKey: false });
export const MonthlySummaryDelivery = mongoose.model("MonthlySummaryDelivery", deliverySchema);
