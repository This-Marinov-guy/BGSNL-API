import mongoose from "mongoose";

const schema = new mongoose.Schema({
  provider: { type: String, enum: ["google"], required: true },
  subject: { type: String, required: true },
  accountId: { type: String, required: true },
  email: { type: String, required: true },
}, { timestamps: true });

// Global uniqueness across both member and alumni collections.
schema.index({ provider: 1, subject: 1 }, { unique: true });
schema.index({ provider: 1, accountId: 1 }, { unique: true });
export default mongoose.model("AccountIdentity", schema);
