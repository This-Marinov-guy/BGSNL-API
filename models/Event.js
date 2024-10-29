import mongoose from "mongoose";
import { EVENT_OPENED } from "../util/config/defines.js";

const Schema = mongoose.Schema;

const eventSchema = new Schema({
  status: { type: String, required: true, default: EVENT_OPENED },
  region: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
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
    guest: {
      discount: { type: Number },
      price: { type: Number },
      priceId: { type: String },
    },
    member: {
      discount: { type: Number },
      price: { type: Number },
      priceId: { type: String },
    },
    activeMember: {
      discount: { type: Number },
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
      isEnabled: { type: Boolean, required: true, default: 0 },
      discount: { type: Number },
      priceId: { type: String },
      startTimer: { type: Date },
      endTimer: { type: Date },
    },
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
      timestamp: { type: Date, default: new Date() },
      name: { type: String, required: true },
      email: { type: String, required: true },
      phone: { type: String, required: true },
      preferences: {
        type: mongoose.Schema.Types.Mixed,
      },
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
