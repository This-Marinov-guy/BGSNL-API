import mongoose from "mongoose";

const Schema = mongoose.Schema;

const eventSchema = new Schema({
  status: { type: String, required: true, default: 'open' },
  region: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
  date: { type: String, required: true },
  time: { type: String, required: true },
  where: { type: String, required: true },
  ticketTimer: { type: String, required: true },
  ticketLimit: { type: String, required: true },
  isSaleClosed: { type: Boolean, required: true },
  isFree: { type: Boolean, required: true },
  isMemberFree: { type: Boolean, required: true },
  entry: { type: String },
  memberEntry: { type: String },
  activeMemberEntry: { type: String },
  entryIncluding: { type: String },
  memberIncluding: { type: String },
  including: { type: [String] },
  ticketLink: { type: String },
  priceId: { type: String },
  memberPriceId: { type: String },
  activeMemberPriceId: { type: String },
  text: { type: String, required: true },
  images: { type: [String] },
  ticketImg: { type: String, required: true },
  ticketColor: { type: String, required: true },
  poster: { type: String, required: true },
  bgImage: { type: Number, required: true, default: 1 },
  bgImageExtra: { type: String },
  membersOnly: { type: Boolean, required: true },
  visible: { type: Boolean, required: true },
  extraInputsForm: {
    type: mongoose.Schema.Types.Mixed
  },
  freePass: { type: [String] },
  discountPass: { type: [String] },
  subEventDescription: { type: String },
  subEventLinks: {
    type: mongoose.Schema.Types.Mixed
  },
  guestList: [
    {
      type: { type: String },
      timestamp: { type: String },
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
