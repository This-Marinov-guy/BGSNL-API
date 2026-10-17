import mongoose from "mongoose";

const pendingPaymentSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // Stripe invoice ID
  type: { type: String, required: true, enum: ["member_revenue_transfer"] },
  reason: { type: String, required: true, enum: ["waiting_stripe_funds"] },
  subscriptionId: { type: String, required: true },
  accountId: { type: String, required: true },
  region: { type: String, required: true },
  operationId: { type: String, required: true },
  amountCents: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true, enum: ["eur"] },
  livemode: { type: Boolean, required: true },
  invoicePaidAt: Date,
}, { collection: "pendingPayments", timestamps: true, versionKey: false });

pendingPaymentSchema.index({ reason: 1, type: 1, createdAt: -1 });

export default mongoose.models.PendingPayment || mongoose.model("PendingPayment", pendingPaymentSchema);
