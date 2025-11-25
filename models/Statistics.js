import mongoose from "mongoose";
import uniqueValidator from "mongoose-unique-validator";

const Schema = mongoose.Schema;

const statisticsSchema = new Schema({
  type: { type: String, required: true },
  lastUpdated: { type: Date, default: new Date()},
  data: { type: mongoose.Schema.Types.Mixed },
});

statisticsSchema.plugin(uniqueValidator);

export default mongoose.model("Statistics", statisticsSchema);
