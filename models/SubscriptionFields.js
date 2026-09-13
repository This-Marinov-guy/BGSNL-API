import mongoose from "mongoose";

export const subscriptionSchema = new mongoose.Schema({
  connected: { type: Boolean, default: false },
  period: Number, id: String, customerId: String, stripeRegion: String,
  priceId: String, status: String, hasBenefits: Boolean, lockReason: String,
  cancelAtPeriodEnd: Boolean, cancelAt: Date, currentPeriodStart: Date, currentPeriodEnd: Date,
  pendingUpdate: Boolean, syncedAt: Date, lastAttemptAt: Date, failureEpisode: String,
  freeAlumniRequested: Boolean, freeAlumniPriceId: String,
}, { _id: false });

// Alumni never participate in regional revenue sharing, including archived
// Alumni documents retained during a switch back to Member.
export const alumniSubscriptionSchema = subscriptionSchema.clone();
alumniSubscriptionSchema.path("connected").set(() => false);

// Retain profile data across both directions of a membership change.
export const sharedMembershipFields = {
  identityRevision: { type: Number, default: 0 },
  sessionVersion: { type: Number, default: 0 },
  accountAliases: [String],
  campaignsSeen: { type: [String], default: () => [] },
  notificationTerms: Boolean, quote: String,
  birth: Date, phone: String, university: String, region: String,
  otherUniversityName: String, graduationDate: String, course: String,
  studentNumber: String, profession: String,
  mmmCampaign2025: { calendarSubscription: Boolean, calendarImage: String },
};
