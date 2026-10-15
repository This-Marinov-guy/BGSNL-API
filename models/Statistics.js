import mongoose from "mongoose";
import uniqueValidator from "mongoose-unique-validator";
import { createCurrentDate } from "../util/functions/currentDate.js";

export const STATISTICS_CALCULATION_TYPES = Object.freeze(["monthly", "on-demand", "weekly", "yearly"]);

const Schema = mongoose.Schema;

const statisticsSchema = new Schema({
  type: { type: String, required: true },
  calculationType: { type: String, enum: STATISTICS_CALCULATION_TYPES, required: true, default: "on-demand" },
  region: { type: String },
  academicYear: { type: String },
  lastUpdated: { type: Date, default: createCurrentDate},
  data: { type: mongoose.Schema.Types.Mixed },
});

statisticsSchema.index({ type: 1, academicYear: 1, region: 1 }, {
  unique: true,
  partialFilterExpression: { type: { $in: ["event-averages", "member-averages"] } },
});

statisticsSchema.plugin(uniqueValidator);

export default mongoose.model("Statistics", statisticsSchema);
