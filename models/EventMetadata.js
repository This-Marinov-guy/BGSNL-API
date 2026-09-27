import mongoose from "mongoose";

// Embedded attribution only; this does not create another collection.
export const eventMetadataSchema = new mongoose.Schema({
  createdBy: { type: String, immutable: true, default: null },
  createdAt: { type: Date, immutable: true, default: null },
  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: null },
}, { _id: false });
