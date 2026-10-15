import mongoose from "mongoose";
import { REGIONS } from "../util/config/defines.js";
import { normalizeMarketingEmail } from "./MarketingEmail.js";

const schema = new mongoose.Schema({
  email: { type: String, required: true, set: normalizeMarketingEmail, maxlength: 320,
    match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email address"] },
  academicYear: { type: String, required: true, match: /^\d{4}-\d{4}$/ },
  region: { type: String, required: true, enum: REGIONS },
  eventIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  firstTicketAt: { type: Date, required: true },
  lastTicketAt: { type: Date, required: true },
}, { collection: "guestMarketingEmails", timestamps: true, versionKey: false });

schema.index({ academicYear: 1, region: 1, email: 1 }, { unique: true, name: "unique_year_region_email" });
schema.index({ email: 1 }, { name: "guest_email_account_cleanup" });

export default mongoose.model("GuestMarketingEmail", schema);
