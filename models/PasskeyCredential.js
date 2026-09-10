import mongoose from "mongoose";

const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  accountId: { type: String, required: true, index: true },
  rpId: { type: String, required: true },
  userHandle: { type: String, required: true },
  name: { type: String, required: true, maxlength: 60 },
  publicKey: { type: Buffer, required: true },
  counter: { type: Number, required: true, min: 0 },
  revision: { type: Number, default: 0 },
  transports: [String],
  deviceType: { type: String, enum: ["singleDevice", "multiDevice"], required: true },
  backedUp: { type: Boolean, required: true },
  lastUsedAt: Date,
}, { timestamps: true });
schema.index({ accountId: 1, rpId: 1 });
// Credential IDs are globally unique; another account can never claim one.
export default mongoose.model("PasskeyCredential", schema);
