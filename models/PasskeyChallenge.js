import mongoose from "mongoose";

const schema = new mongoose.Schema({
  _id: String,
  purpose: { type: String, enum: ["register", "login"], required: true },
  challenge: { type: String, required: true },
  proofHash: { type: String, required: true },
  origin: { type: String, required: true },
  rpId: { type: String, required: true },
  accountId: String,
  passwordHash: String,
  sessionVersion: Number,
  userHandle: String,
  name: String,
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.model("PasskeyChallenge", schema);
