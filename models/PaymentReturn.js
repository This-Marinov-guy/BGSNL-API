import mongoose from "mongoose";

// A narrowly scoped receipt capability, not an account session. Only its hash
// is stored here; Stripe objects and expiry are always checked server-side.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  kind: { type: String, enum: ["ticket", "subscription", "donation", "free"], required: true },
  region: { type: String, required: true },
  origin: { type: String, required: true },
  returnPath: { type: String, required: true },
  stripeId: String,
  title: String,
  quantity: Number,
  confirmedAt: Date,
  expiresAt: { type: Date, required: true },
}, { timestamps: true, versionKey: false });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("PaymentReturn", schema);
