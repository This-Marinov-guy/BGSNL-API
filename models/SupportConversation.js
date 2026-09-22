import mongoose from "mongoose";
import { MAX_MESSAGES, SUPPORT_STATUSES, SUPPORT_TYPES } from "../services/support/policy.js";

const attachmentSchema = new mongoose.Schema({
  type: { type: String, enum: ["image"], required: true },
  url: {
    type: String,
    required: true,
    maxlength: 2000,
    validate: (value) => /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(value),
  },
}, { _id: false });

const messageSchema = new mongoose.Schema({
  id: { type: String, required: true },
  text: {
    type: String,
    default: "",
    maxlength: 4000,
    validate: function (value) { return this.kind === "status" || !!value?.trim() || this.attachments?.length > 0; },
  },
  attachments: { type: [attachmentSchema], default: [], validate: (attachments) => attachments.length <= 3 },
  author: { type: String, enum: ["requester", "staff"], required: true },
  authorAccountId: { type: String, default: null },
  kind: { type: String, enum: ["message", "status"], default: "message" },
  createdAt: { type: Date, required: true },
}, { _id: false });

const dimensionsSchema = new mongoose.Schema({
  width: { type: Number, min: 1, max: 20000 },
  height: { type: Number, min: 1, max: 20000 },
}, { _id: false });

const environmentSchema = new mongoose.Schema({
  userAgent: { type: String, maxlength: 600 },
  browser: { type: String, maxlength: 80 },
  platform: { type: String, maxlength: 100 },
  deviceType: { type: String, maxlength: 40 },
  language: { type: String, maxlength: 40 },
  timezone: { type: String, maxlength: 100 },
  viewport: { type: dimensionsSchema, default: undefined },
  screen: { type: dimensionsSchema, default: undefined },
  devicePixelRatio: { type: Number, min: 0.1, max: 10 },
  touchPoints: { type: Number, min: 0, max: 100 },
}, { _id: false });

const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  ownerAccountId: { type: String, default: null },
  contact: {
    name: { type: String, required: true, maxlength: 160 },
    email: { type: String, maxlength: 254 }, phone: { type: String, maxlength: 40 },
    source: { type: String, enum: ["account", "guest"], required: true },
  },
  type: { type: String, enum: SUPPORT_TYPES, default: "problem" },
  subject: { type: String, required: true, maxlength: 140 },
  pagePath: { type: String, required: true, maxlength: 500 },
  environment: { type: environmentSchema, default: undefined },
  status: { type: String, enum: SUPPORT_STATUSES, default: "open" },
  guestSecretHash: { type: String, select: false },
  guestAccessExpiresAt: Date,
  requestHash: { type: String, required: true, select: false },
  messages: { type: [messageSchema], validate: (messages) => messages.length <= MAX_MESSAGES },
  messageCount: { type: Number, default: 1 },
  lastAuthor: { type: String, enum: ["requester", "staff"], default: "requester" },
  lastMessageAt: { type: Date, required: true },
  revision: { type: Number, default: 0 },
}, { timestamps: true });

schema.index({ ownerAccountId: 1, lastMessageAt: -1, _id: -1 });
schema.index({ status: 1, lastMessageAt: -1, _id: -1 });
schema.index({ lastMessageAt: -1, _id: -1 });
export default mongoose.model("SupportConversation", schema, "supportConversations");
