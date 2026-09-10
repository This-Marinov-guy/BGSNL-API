import mongoose from "mongoose";

// The claim is stored before delivery. This intentionally favours at-most-once
// birthday greetings over retrying an ambiguous provider response and sending
// a duplicate message after a restart or on another API instance.
const schema = new mongoose.Schema({
  _id: String,
  dateKey: { type: String, required: true },
  recipientHash: { type: String, required: true },
  accountId: { type: String, required: true },
  accountType: { type: String, enum: ["member", "alumni"], required: true },
  attemptedAt: Date,
  completedAt: Date,
  lastDeliveryError: String,
}, { timestamps: true });

schema.index({ dateKey: 1, recipientHash: 1 }, { unique: true });

export default mongoose.model("BirthdayEmailDelivery", schema);
