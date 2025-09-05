import mongoose from "mongoose";
import uniqueValidator from "mongoose-unique-validator";
import { MEMBER } from "../util/config/defines.js";
import { ACTIVE, USER_STATUSES } from "../util/config/enums.js";

const Schema = mongoose.Schema;

const userSchema = new Schema({
  status: { type: String, required: true, default: USER_STATUSES[ACTIVE] },
  roles: { type: Array, required: true, default: [MEMBER] },
  subscription: {
    period: { type: Number },
    id: { type: String },
    customerId: { type: String },
  },
  region: { type: String },
  purchaseDate: { type: Date, default: new Date(), required: true },
  expireDate: { type: Date, required: true },
  image: { type: String, required: true },
  name: { type: String, required: true },
  surname: { type: String, required: true },
  birth: { type: Date, required: true },
  phone: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  university: { type: String, required: true },
  otherUniversityName: { type: String },
  graduationDate: { type: String },
  course: { type: String },
  studentNumber: { type: String },
  password: { type: String, required: true, minlength: 5 },
  notificationTypeTerms: { type: String },
  tickets: [
    {
      event: { type: String, required: true },
      purchaseDate: { type: Date, default: new Date() },
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
});

userSchema.plugin(uniqueValidator);

export default mongoose.model("User", userSchema);
