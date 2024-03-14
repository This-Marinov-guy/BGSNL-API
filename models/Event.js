import mongoose from "mongoose";

const Schema = mongoose.Schema;

const eventSchema = new Schema({
  status: { type: String },
  region: { type: String, required: true },
  ticketPool: { type: Number },
  event: { type: String, require: true },
  date: { type: String, require: true },
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
      marketing: {
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
