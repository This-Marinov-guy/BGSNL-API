import mongoose from "mongoose";
import { randomBytes } from "node:crypto";

const schema = new mongoose.Schema({
  token: { type: String, required: true, default: () => randomBytes(16).toString("base64url") },
  eventId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "Event" },
  code: { type: String, required: true },
}, { timestamps: true });
schema.index({ token: 1 }, { unique: true });
schema.index({ eventId: 1, code: 1 }, { unique: true });
export default mongoose.model("TicketQr", schema);
