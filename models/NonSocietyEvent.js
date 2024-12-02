import mongoose from "mongoose";

const Schema = mongoose.Schema;

const eventSchema = new Schema({
  event: { type: String, require: true },
  date: { type: Date },
  guestList: [
    {
      user: { type: String, required: true },
      timestamp: { type: Date, default: new Date() },
      name: { type: String, required: true },
      ticket: { type: String },
      extraData: { type: String },
      email: { type: String, required: true },
      phone: { type: String, required: true },
      notificationTypeTerms: { type: String, required: true },
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

export default mongoose.model("NonSocietyEvent", eventSchema);
