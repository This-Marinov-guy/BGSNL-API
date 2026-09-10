import mongoose from "mongoose";

const schema = new mongoose.Schema({
  _id: String, generation: String, accountId: String,
  oldEmail: String, newEmail: String, passwordHash: String, passwordDigest: String,
  sessionVersion: Number, authTime: Number, origin: String,
  stage: { type: String, enum: ["owner", "new_email"] },
  approvalHash: String, newEmailHash: String, expiresAt: Date,
});
schema.index({ approvalHash: 1 }, { unique: true, sparse: true });
schema.index({ newEmailHash: 1 }, { unique: true, sparse: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.model("ProfileChange", schema);
