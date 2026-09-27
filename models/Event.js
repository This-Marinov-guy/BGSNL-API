import mongoose from "mongoose";
import { eventMetadataSchema } from "./EventMetadata.js";
import { EVENT_OPENED } from "../util/config/defines.js";
import { createCurrentDate } from "../util/functions/currentDate.js";

const Schema = mongoose.Schema;

const ticketTierSchema = new Schema(
  {
    discount: { type: Number },
    originalPrice: { type: Number },
    price: { type: Number },
    priceId: { type: String },
  },
  { _id: false }
);

const ticketPromocodeSchema = new Schema(
  {
    id: { type: String, required: true },
    couponId: { type: String, required: true },
    customerScoped: { type: Boolean, default: false },
    audiences: { type: [String], enum: ["guest", "member", "activeMember"], default: ["guest", "member"] },
    redeemedBefore: { type: Number, default: 0 },
    exhausted: { type: Boolean, default: false },
    code: { type: String, required: true },
    discountType: { type: Number, required: true },
    discount: { type: Number, required: true },
    useLimit: { type: Number },
    timeLimit: { type: Date },
    minAmount: { type: Number },
    active: { type: Boolean, default: true },
  },
  { _id: false }
);

const ticketProductSchema = new Schema(
  {
    id: { type: String },
    earlyBird: { type: Boolean, default: false },
    lateBird: { type: Boolean, default: false },
    promoCodes: { type: [ticketPromocodeSchema], default: [] },
    guest: { type: ticketTierSchema, default: undefined },
    member: { type: ticketTierSchema, default: undefined },
    activeMember: { type: ticketTierSchema, default: undefined },
  },
  { _id: false }
);

const ticketPromotionSchema = new Schema(
  {
    isEnabled: { type: Boolean, required: true, default: false },
    discount: { type: Number, default: 0 },
    priceId: { type: String },
    startTimer: { type: Date },
    endTimer: { type: Date },
  },
  { _id: false }
);

const ticketBirdStageSchema = new Schema(
  {
    isEnabled: { type: Boolean, required: true, default: false },
    excludeMembers: { type: Boolean, default: false },
    ticketLimit: { type: Number },
    ticketTimer: { type: Date },
    startTimer: { type: Date },
    price: { type: Number },
    priceId: { type: String },
    memberPrice: { type: Number },
    memberPriceId: { type: String },
  },
  { _id: false, strict: false }
);

const eventSchema = new Schema({
  memberAnnouncementQueuedAt: Date,
  memberAnnouncementCompletedAt: Date,
  metadata: { type: eventMetadataSchema, default: undefined },
  createdAt: { type: Date, immutable: true, default: createCurrentDate },
  status: { type: String, required: true, default: EVENT_OPENED },
  region: { type: String, required: true },
  title: { type: String, required: true },
  // Assigned once at publication. Existing records remain readable without a
  // slug until the explicit backfill is run; new values are unique within their region.
  slug: { type: String, immutable: true, trim: true },
  description: { type: String, default: "" },
  date: { type: Date, required: true },
  correctedDate: { type: Date },
  location: { type: String, required: true },
  ticketTimer: { type: Date, required: true },
  ticketLimit: { type: Number, required: true },
  isSaleClosed: { type: Boolean, required: true, default: false },
  isFree: { type: Boolean, required: true, default: false },
  isMemberFree: { type: Boolean, required: true, default: false },
  product: { type: ticketProductSchema, default: undefined },
  promotion: {
    guest: { type: ticketPromotionSchema, default: () => ({}) },
    member: { type: ticketPromotionSchema, default: () => ({}) },
  },
  addOns: {
    isEnabled: { type: Boolean, required: true, default: false },
    isMandatory: { type: Boolean, required: true, default: false },
    multi: { type: Boolean },
    title: { type: String },
    description: { type: String },
    items: [
      {
        title: { type: String },
        description: { type: String },
        price: { type: Number },
        priceId: { type: String },
      },
    ],
  },
  entryIncluding: { type: String },
  memberIncluding: { type: String },
  including: { type: String },
  ticketLink: { type: String },
  text: { type: String, required: true },
  images: { type: [String] },
  ticketImg: { type: String, required: true },
  ticketColor: { type: String, required: true, default: "#faf9f6" },
  ticketQR: { type: Boolean, required: true, default: true },
  ticketName: { type: Boolean, required: true, default: true },
  poster: { type: String, required: true },
  memberOnly: { type: Boolean, required: true, default: false },
  hidden: { type: Boolean, required: true, default: false },
  googleEventId: { type: String },
  extraInputsForm: {
    type: mongoose.Schema.Types.Mixed,
  },
  earlyBird: {
    type: ticketBirdStageSchema,
    default: undefined,
  },
  lateBird: {
    type: ticketBirdStageSchema,
    default: undefined,
  },
  subEvent: {
    description: { type: String, default: "" },
    links: {
      type: mongoose.Schema.Types.Mixed,
      default: [
        {
          name: "",
          href: "",
        },
      ],
    },
  },
  folder: {
    type: String,
    required: true,
  },
  sheetName: {
    type: String,
    required: true,
  },
  guestList: [
    {
      // status 0 - not came
      // status 1 - came
      status: { type: Number, default: 0 },
      checkedInAt: { type: Date },
      code: { type: Number },
      type: { type: String },
      userId: { type: String },
      memberPriceApplied: { type: Boolean, default: false },
      transactionId: { type: String, default: "-" },
      timestamp: { type: Date, default: createCurrentDate },
      name: { type: String, required: true },
      email: { type: String, required: true },
      phone: { type: String, required: true },
      preferences: {
        type: mongoose.Schema.Types.Mixed,
      },
      addOns: [
        {
          id: { type: Number },
          title: { type: String },
          price: { type: Number },
        },
      ],
      ticket: { type: String },
      refunded: { type: Boolean, default: false },
      refundReason: { type: String },
    },
  ],
});

eventSchema.static(
  "findOneOrCreate",
  async function findOneOrCreate(condition, doc) {
    const one = await this.findOne(condition);

    return one || this.create(doc);
  }
);

eventSchema.index({ memberAnnouncementQueuedAt: 1, memberAnnouncementCompletedAt: 1 });

// Missing legacy slugs are excluded until backfilled.
eventSchema.index({ region: 1, slug: 1 }, {
  name: "event_region_slug_unique",
  unique: true,
  partialFilterExpression: { slug: { $type: "string" } },
});

export default mongoose.model("Event", eventSchema);
