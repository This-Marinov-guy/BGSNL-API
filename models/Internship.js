import mongoose from "mongoose";
import { createCurrentDate } from "../util/functions/currentDate.js";

const Schema = mongoose.Schema;

const internshipSchema = new Schema({
  company: { type: String, required: true },
  specialty: { type: String, required: true },
  location: { type: String, required: true },
  label: { type: String, enum: ["Bulgarian", "International & Remote"], required: true },
  duration: { type: String, required: false },
  description: { type: String, required: false },
  bonuses: { type: String, required: false },
  requirements: { type: String, required: false },
  languages: { type: String, required: false },
  contactMail: { type: String, required: false },
  website: { type: String, required: false },
  applyLink: { type: String, required: false },
  logo: { type: String, required: false, default: "" },
  isActive: { type: Boolean, default: true },
  position: { type: Number, default: null },
  createdAt: { type: Date, default: createCurrentDate, required: true },
  updatedAt: { type: Date, default: createCurrentDate },
});

export default mongoose.model("Internship", internshipSchema);
