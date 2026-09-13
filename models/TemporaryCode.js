import mongoose from "mongoose";

const Schema = mongoose.Schema;

const temporaryCodeSchema = new Schema({
  userId: { type: String, required: true },
  code: { type: String, required: true },
  life: { type: Number, required: true, default: 3 },
});

temporaryCodeSchema.add({ expiresAt: Date });
temporaryCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

temporaryCodeSchema.static(
  "findOneOrCreate",
  async function findOneOrCreate(condition, doc) {
    const one = await this.findOne(condition);

    return one || this.create(doc);
  }
);

export default mongoose.model("TemporaryCode", temporaryCodeSchema);
