import { temporaryRecordStore } from "../services/storage/temporary-records.js";
import mongoose from "mongoose";

const schema = new mongoose.Schema({
  _id: String,
  purpose: { type: String, enum: ["login", "link", "register"], required: true },
  kind: { type: String, enum: ["google", "passkey"], default: "google" },
  nonce: { type: String, required() { return this.kind === "google"; } },
  challenge: { type: String, required() { return this.kind === "passkey"; } },
  rpId: String,
  userHandle: String,
  name: String,
  proofHash: { type: String, required: true },
  origin: { type: String, required: true },
  accountId: String,
  accountEmail: String,
  passwordHash: String,
  sessionVersion: Number,
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default temporaryRecordStore("AuthChallenge", schema);
