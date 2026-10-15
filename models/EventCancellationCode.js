import mongoose from "mongoose";
import { temporaryRecordStore } from "../services/storage/temporary-records.js";

const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  generation: { type: String, required: true },
  codeHash: { type: String, required: true },
  region: { type: String, required: true },
  recipient: { type: String, required: true },
  attemptsLeft: { type: Number, required: true },
  requestedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Namespaced records live in the existing temporaryCodes collection.
export default temporaryRecordStore("EventCancellationCode", schema);
