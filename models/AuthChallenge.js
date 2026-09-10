import mongoose from "mongoose";

const schema = new mongoose.Schema({
  _id: String,
  purpose: { type: String, enum: ["login", "link"], required: true },
  nonce: { type: String, required: true },
  proofHash: { type: String, required: true },
  origin: { type: String, required: true },
  accountId: String,
  accountEmail: String,
  passwordHash: String,
  sessionVersion: Number,
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.model("AuthChallenge", schema);
