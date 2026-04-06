import mongoose from "mongoose";
import { createCurrentDate } from "../util/functions/currentDate.js";

const Schema = mongoose.Schema;

const internshipApplicationSchema = new Schema({
  userId: { type: String, required: false },
  email: { type: String, required: true },
  name: { type: String, required: true },
  phone: { type: String, required: false },
  companyId: { type: String, required: true },
  companyName: { type: String, required: true },
  position: { type: String, required: true },
  cv: { type: String, required: false },
  coverLetter: { type: String, required: false },
  createdAt: { type: Date, default: createCurrentDate, required: true },
});

export default mongoose.model("InternshipApplication", internshipApplicationSchema);
