import mongoose from "mongoose";
import { EVENT_DRAFT } from "../util/config/defines.js";
import { createCurrentDate } from "../util/functions/currentDate.js";

const eventDraftSchema = new mongoose.Schema({
  createdAt: { type: Date, immutable: true, default: createCurrentDate },
  lastUpdate: {
    timestamp: { type: Date },
    id: { type: String },
  },
  status: {
    type: String,
    immutable: true,
    default: EVENT_DRAFT,
    enum: [EVENT_DRAFT],
  },
  region: { type: String },
  title: { type: String, default: "" },
  description: { type: String, default: "" },
  date: { type: Date },
  location: { type: String, default: "" },
  ticketTimer: { type: Date },
  ticketLimit: { type: Number },
  text: { type: String, default: "" },
  memberOnly: { type: Boolean, default: false },
  hidden: { type: Boolean, default: false },
  isSaleClosed: { type: Boolean, default: false },
  isFree: { type: Boolean, default: false },
  isMemberFree: { type: Boolean, default: false },
  images: { type: [String], default: [] },
  ticketImg: { type: String },
  poster: { type: String },
  bgImageExtra: { type: String },
  folder: { type: String },
  draftData: { type: mongoose.Schema.Types.Mixed, default: {} },
  draftOwner: {
    userId: { type: String },
    region: { type: String },
  },
});

eventDraftSchema.index({ region: 1, createdAt: -1 });
eventDraftSchema.index({ "draftOwner.userId": 1, createdAt: -1 });

// Explicit collection name prevents Mongoose from lowercasing it to
// "eventdrafts". Event drafts are intentionally separate from "events".
export default mongoose.model("EventDraft", eventDraftSchema, "eventDrafts");
