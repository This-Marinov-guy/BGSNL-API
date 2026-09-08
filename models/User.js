import mongoose from "mongoose";
import uniqueValidator from "mongoose-unique-validator";
import { MEMBER } from "../util/config/defines.js";
import { ACTIVE, USER_STATUSES } from "../util/config/enums.js";
import { createCurrentDate } from "../util/functions/currentDate.js";
import { subscriptionSchema, sharedMembershipFields } from "./SubscriptionFields.js";

const Schema = mongoose.Schema;

const userSchema = new Schema({
  ...sharedMembershipFields,
  _id: {
    type: String,
    default: () => "member_" + new mongoose.Types.ObjectId(),
  },
  status: { type: String, required: true, default: USER_STATUSES[ACTIVE] },
  roles: { type: Array, required: true, default: [MEMBER] },
  documents: [{ type: Schema.Types.ObjectId, ref: "Document" }],
  subscription: { type: subscriptionSchema, default: () => ({}) },
  region: { type: String },
  purchaseDate: { type: Date, default: createCurrentDate, required: true },
  expireDate: { type: Date, required: true },
  image: { type: String, required: true },
  name: { type: String, required: true },
  surname: { type: String, required: true },
  birth: { type: Date, required() { return !this.accountAliases?.length; } },
  phone: { type: String, required() { return !this.accountAliases?.length; } },
  email: { type: String, required: true, unique: true },
  university: { type: String, required() { return !this.accountAliases?.length; } },
  otherUniversityName: { type: String },
  graduationDate: { type: String },
  course: { type: String },
  studentNumber: { type: String },
  profession: { type: String },
  password: { type: String, required: true, minlength: 5 },
  notificationTypeTerms: { type: String },
  tickets: [
    {
      event: { type: String, required: true },
      purchaseDate: { type: Date, default: createCurrentDate },
      image: { type: String, required: true },
      // default: []
    },
  ],
  christmas: [
    {
      sender: { type: String },
      receiver: { type: String },
      text: { type: String, required: true },
      gif: { type: String },
    },
  ],
  mmmCampaign2025: {
    calendarSubscription: { type: Boolean, default: false },
    calendarImage: { type: String, default: "" },
  },
  joinDate: { type: Date, default: createCurrentDate, required: true },
  internshipApplications: [
    { type: Schema.Types.ObjectId, ref: "InternshipApplication" },
  ],
});

userSchema.plugin(uniqueValidator);
userSchema.index({ "subscription.id": 1, status: 1 });
userSchema.index({ accountAliases: 1 });
userSchema.index({ "subscription.syncedAt": 1, status: 1 });
userSchema.index({ "subscription.lastAttemptAt": 1, "subscription.syncedAt": 1 });

export default mongoose.model("User", userSchema);
