import mongoose from "mongoose";

export const identitySchema = new mongoose.Schema({
  _id: { type: String, required: true },
  provider: { type: String, enum: ["google"], required: true },
  subject: { type: String, required: true },
  email: { type: String, required: true },
}, { timestamps: true });

export const passkeySchema = new mongoose.Schema({
  _id: { type: String, required: true },
  rpId: { type: String, required: true },
  userHandle: { type: String, required: true },
  name: { type: String, required: true, maxlength: 60 },
  publicKey: { type: Buffer, required: true },
  counter: { type: Number, required: true, min: 0 },
  revision: { type: Number, default: 0 },
  transports: [String],
  deviceType: { type: String, enum: ["singleDevice", "multiDevice"], required: true },
  backedUp: { type: Boolean, required: true },
  lastUsedAt: Date,
}, { timestamps: true });

export const accountSecurityFields = {
  identities: { type: [identitySchema], default: undefined, select: false },
  passkeys: { type: [passkeySchema], default: undefined, select: false },
};

export function accountSecurityIndexes(schema) {
  // Cross-collection uniqueness is enforced by the shared transaction lock.
  schema.index({ "identities.subject": 1 }, { unique: true, partialFilterExpression: { "identities.subject": { $type: "string" } } });
  schema.index({ "passkeys._id": 1 }, { unique: true, partialFilterExpression: { "passkeys._id": { $type: "string" } } });
  schema.set("toJSON", { transform(_doc, value) {
    delete value.identities;
    delete value.passkeys;
    return value;
  } });
}
