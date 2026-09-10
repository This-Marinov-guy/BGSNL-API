import mongoose from "mongoose";

// One current reset challenge per account, not a persisted login session.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  generation: { type: String, required: true },
  codeHash: { type: String, required: true },
  passwordDigest: { type: String, required: true },
  email: { type: String, required: true },
  attemptsLeft: { type: Number, required: true },
  expiresAt: { type: Date, required: true },
});
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.model("PasswordResetChallenge", schema);
