import mongoose from "mongoose";
import { DEFAULT_REGION } from "../util/config/defines.js";
import { createCurrentDate } from "../util/functions/currentDate.js";

const Schema = mongoose.Schema;

const eventSchema = new Schema({
  event: { type: String, require: true },
  referenceCode: { type: String },
  region: { type: String, required: true, default: DEFAULT_REGION },
  date: { type: Date },
  timezone: { type: String, default: "Europe/Amsterdam" },
  guestList: [
    {
      user: { type: String, required: true },
      userId: { type: String },
      timestamp: { type: Date, default: createCurrentDate },
      name: { type: String, required: true },
      ticket: { type: String },
      course: { type: String },
      university: { type: String },
      questions: { type: String },
      extraData: { type: String },
      email: { type: String, required: true },
      phone: { type: String },
      notificationTypeTerms: { type: String, required: true },
    },
  ],
});

eventSchema.static(
  "findOneOrCreate",
  async function findOneOrCreate(condition, doc) {
    const one = await this.findOne(condition);

    return one || this.create(doc);
  }
);

export default mongoose.model("NonSocietyEvent", eventSchema);
