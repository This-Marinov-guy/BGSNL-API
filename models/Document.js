import mongoose from "mongoose";
import { DOCUMENT_TYPES } from "../util/config/enums.js";

const Schema = mongoose.Schema;

const documentSchema = new Schema({
  type: { 
    type: Number, 
    required: true,
    enum: [DOCUMENT_TYPES.CV, DOCUMENT_TYPES.COVER_LETTER]
  },
  name: { type: String, required: true },
  content: { type: String, required: true }, // This is a link
  lastUpdated: { type: Date, default: new Date(), required: true },
});

export default mongoose.model("Document", documentSchema);
