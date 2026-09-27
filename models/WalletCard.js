import mongoose from "mongoose";

// Profile data is resolved live, never copied into this record.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  accountId: { type: String, required: true },
  token: { type: String, required: true, unique: true },
  // Historical opt-ins remain intact; automatic provisioning is not consent.
  consentVersion: { type: Number },
  consentedAt: { type: Date },
  provisionedAutomatically: { type: Boolean, default: false },
  revokedAt: { type: Date, default: null },
}, { timestamps: true, collection: "walletCards" });
export default mongoose.models.WalletCard || mongoose.model("WalletCard", schema);
