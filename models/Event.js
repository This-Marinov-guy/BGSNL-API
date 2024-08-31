import mongoose from "mongoose";
import { EVENT_OPENED } from "../util/config/defines.js";

const Schema = mongoose.Schema;

const eventSchema = new Schema({
  status: { type: String, required: true, default: EVENT_OPENED },
  region: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
  date: { type: Date, required: true },
  time: { type: String, required: true },
  correctedDate: { type: Date},
  correctedTime: { type: String },
  location: { type: String, required: true },
  ticketTimer: { type: Date, required: true },
  ticketLimit: { type: Number, required: true },
  isSaleClosed: { type: Boolean, required: true, default: false },
  isFree: { type: Boolean, required: true, default: false },
  isMemberFree: { type: Boolean, required: true, default: false },
  // product : {
  //   id: {type: String, required: true},
  //   entry : {
  //     price: { type: Number, required: true },
  //     priceId: { type: String, required: true }
  //   },
  //   memberEntry: {
  //     price: { type: Number, required: true },
  //     priceId: { type: String, required: true }
  //   },
  //   activeMemberEntry: {
  //     price: { type: Number, required: true },
  //     priceId: { type: String, required: true }
  //   }
  // },
  entry: { type: Number, default: null },
  memberEntry: { type: Number, default: null },
  activeMemberEntry: { type: Number, default: null },
  entryIncluding: { type: String },
  memberIncluding: { type: String },
  including: { type: String },
  ticketLink: { type: String },
  priceId: { type: String },
  memberPriceId: { type: String },
  activeMemberPriceId: { type: String },
  text: { type: String, required: true },
  images: { type: [String] },
  ticketImg: { type: String, required: true },
  ticketColor: { type: String, required: true, default: '#faf9f6' },
  poster: { type: String, required: true },
  bgImage: { type: Number, required: true, default: 1 },
  bgImageExtra: { type: String },
  bgImageSelection: { type: String },
  memberOnly: { type: Boolean, required: true, default: false },
  hidden: { type: Boolean, required: true, default: false },
  extraInputsForm: {
    type: mongoose.Schema.Types.Mixed
  },
  subEvent: {
    description: { type: String, default: '' },
    links: {
      type: mongoose.Schema.Types.Mixed,
      default: [{
        name: '',
        href: ''
      }]
    }
  },
  freePass: { type: [String] },
  discountPass: { type: [String] },
  folder: {
    type: String, required: true
  },
  guestList: [
    {
      // status 0 - not came
      // status 1 - came
      status: { type: Number, default: 0 },
      type: { type: String },
      timestamp: { type: Date, default: new Date() },
      name: { type: String, required: true },
      email: { type: String, required: true },
      phone: { type: String, required: true },
      preferences: {
        type: mongoose.Schema.Types.Mixed
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
