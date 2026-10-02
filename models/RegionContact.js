import mongoose from "mongoose";
import { REGIONS } from "../util/config/defines.js";

export const REGION_CONTACT_KEYS = Object.freeze([...REGIONS, "netherlands", "support"]);
export const REGION_CONTACT_EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const schema = new mongoose.Schema({
  _id: { type: String, enum: REGION_CONTACT_KEYS, required: true },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254,
    match: REGION_CONTACT_EMAIL_PATTERN },
}, { collection: "regionContacts", versionKey: false, timestamps: true });

export default mongoose.model("RegionContact", schema);
