import mongoose from "mongoose";
import { EVENT_OPENED } from "../util/config/defines.js";

const Schema = mongoose.Schema;

const eventSchema = new Schema({
  createdAt: { type: Date, immutable: true, default: Date.now },
  lastUpdate: {
    timestamp: { type: Date },
    id: { type: String },
  },
  status: { type: String, required: true, default: EVENT_OPENED },
  region: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, default: "" },
  date: { type: Date, required: true },
  correctedDate: { type: Date },
  location: { type: String, required: true },
  ticketTimer: { type: Date, required: true },
  ticketLimit: { type: Number, required: true },
  isSaleClosed: { type: Boolean, required: true, default: false },
  isFree: { type: Boolean, required: true, default: false },
  isMemberFree: { type: Boolean, required: true, default: false },
  product: {
    id: { type: String },
    earlyBird: { type: Boolean, default: false },
    lateBird: { type: Boolean, default: false },
    promoCodes: {
      type: [
        {
          id: { type: String, required: true }, // Stripe promotion code ID
          couponId: { type: String, required: true }, // Stripe coupon ID
          code: { type: String, required: true }, // The actual code string
          discountType: { type: Number, required: true }, // 1=fixed, 2=percentage
          discount: { type: Number, required: true }, // Discount value
          useLimit: { type: Number, required: false }, // Max redemptions
          timeLimit: { type: Date, required: false }, // Expiration date
          minAmount: { type: Number, required: false }, // Minimum purchase amount
          active: { type: Boolean, default: true }, // Whether the code is active
        },
      ],
      default: [],
    },
    guest: {
      discount: { type: Number },
      originalPrice: { type: Number },
      price: { type: Number },
      priceId: { type: String },
    },
    member: {
      discount: { type: Number },
      originalPrice: { type: Number },
      price: { type: Number },
      priceId: { type: String },
    },
    activeMember: {
      discount: { type: Number },
      originalPrice: { type: Number },
      price: { type: Number },
      priceId: { type: String },
    },
  },
  promotion: {
    guest: {
      isEnabled: { type: Boolean, required: true, default: false },
      discount: { type: Number, default: 0 },
      priceId: { type: String },
      startTimer: { type: Date },
      endTimer: { type: Date },
    },
    member: {
      isEnabled: { type: Boolean, required: true, default: false },
      discount: { type: Number },
      priceId: { type: String },
      startTimer: { type: Date },
      endTimer: { type: Date },
    },
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
  bgImage: { type: Number, required: true, default: 1 },
  bgImageExtra: { type: String },
  bgImageSelection: { type: Number, default: 1 },
  memberOnly: { type: Boolean, required: true, default: false },
  hidden: { type: Boolean, required: true, default: false },
  googleEventId: { type: String },
  extraInputsForm: {
    type: mongoose.Schema.Types.Mixed,
  },
  earlyBird: {
    type: mongoose.Schema.Types.Mixed,
  },
  lateBird: {
    type: mongoose.Schema.Types.Mixed,
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
  freePass: { type: [String] },
  discountPass: { type: [String] },
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
      code: { type: Number },
      type: { type: String },
      transactionId: { type: String, default: "-" },
      timestamp: { type: Date, default: new Date() },
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

export default mongoose.model("Event", eventSchema);
