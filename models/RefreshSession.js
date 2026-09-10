import mongoose from "mongoose";

const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  accountId: { type: String, required: true },
  sessionVersion: { type: Number, required: true },
  authVersion: { type: Number, required: true },
  authTime: { type: Number, required: true },
  lastActivityAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  generation: { type: Number, required: true, default: 0 },
  tokenHash: { type: String, required: true, select: false },
  rotatedAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
}, { versionKey: false });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ accountId: 1 });
export default mongoose.model("RefreshSession", schema);
