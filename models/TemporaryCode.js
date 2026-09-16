import mongoose from "mongoose";
import { TEMPORARY_RECORDS_COLLECTION } from "../services/storage/temporary-records.js";

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

// Shares its physical collection with services/storage/temporary-records.js's
// models (see TEMPORARY_RECORDS_COLLECTION there for why it's configurable).
export default mongoose.model("TemporaryCode", temporaryCodeSchema, TEMPORARY_RECORDS_COLLECTION);
