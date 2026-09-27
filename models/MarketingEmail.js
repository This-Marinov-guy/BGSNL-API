import mongoose from "mongoose";

const Schema = mongoose.Schema;

export const normalizeMarketingEmail = (email) =>
  typeof email === "string" ? email.trim().toLowerCase() : email;
export const normalizeMarketingCity = (city) =>
  typeof city === "string"
    ? city.trim().replace(/\s+/g, " ").toLowerCase()
    : city;

const marketingEmailSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      set: normalizeMarketingEmail,
      maxlength: 320,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email address"],
    },
    city: {
      type: String,
      required: true,
      set: normalizeMarketingCity,
      maxlength: 120,
    },
    addedAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
    unsubscribed: {
      type: Boolean,
      required: true,
      default: true,
    },
    consent: {
      granted: { type: Boolean, required: true, default: false },
      source: { type: String, maxlength: 240 },
      recordedAt: { type: Date },
      textVersion: { type: String, maxlength: 80 },
    },
  },
  {
    collection: "marketingEmails",
    versionKey: false,
  }
);

// An address can exist in several cities, but only once in any single city.
// Since city is the index prefix, this also supports fast recipient lookups.
marketingEmailSchema.index(
  { city: 1, email: 1 },
  { unique: true, name: "unique_city_email" }
);

// Supports city exports filtered or sorted by the date the address was added.
marketingEmailSchema.index(
  { city: 1, addedAt: 1 },
  { name: "city_added_at" }
);

// Optimizes campaign recipient reads while excluding unsubscribed addresses.
marketingEmailSchema.index(
  { city: 1, unsubscribed: 1, "consent.granted": 1, email: 1 },
  { name: "city_consent_subscription_email" }
);

marketingEmailSchema.static("add", async function add({ email, city, consent }, { maxTimeMS } = {}) {
  const normalizedEmail = normalizeMarketingEmail(email);
  const normalizedCity = normalizeMarketingCity(city);
  if (consent?.granted !== true) {
    throw new Error("Recorded marketing consent is required");
  }
  const recordedAt = consent.recordedAt ? new Date(consent.recordedAt) : new Date();
  const queryOptions = maxTimeMS ? { maxTimeMS } : {};

  try {
    return await this.findOneAndUpdate(
      { email: normalizedEmail, city: normalizedCity, $or: [
        { "consent.recordedAt": { $lt: recordedAt } },
        { "consent.recordedAt": null },
      ] },
      {
        $set: {
          unsubscribed: false,
          consent: {
            granted: true,
            source: consent.source || "unknown",
            recordedAt,
            textVersion: consent.textVersion || "unknown",
          },
        },
        $setOnInsert: {
          email: normalizedEmail,
          city: normalizedCity,
        },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        ...queryOptions,
      }
    );
  } catch (error) {
    // Concurrent upserts and replays of the same/older consent hit the unique
    // pair index. Never replay an opt-in over newer consent or an unsubscribe.
    if (error?.code === 11000) {
      return this.findOne({ email: normalizedEmail, city: normalizedCity }, null, queryOptions);
    }

    throw error;
  }
});

marketingEmailSchema.static("findByCity", function findByCity(city) {
  return this.find({
    city: normalizeMarketingCity(city),
    unsubscribed: false,
    "consent.granted": true,
  })
    .select({ _id: 0, email: 1, addedAt: 1 })
    .sort({ email: 1 })
    .lean();
});

export default mongoose.model("MarketingEmail", marketingEmailSchema);
