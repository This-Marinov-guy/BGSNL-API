import mongoose from "mongoose";
import uniqueValidator from "mongoose-unique-validator";
import { ALUMNI } from "../util/config/defines.js";
import { ACTIVE, USER_STATUSES } from "../util/config/enums.js";

const Schema = mongoose.Schema;

const alumniUserSchema = new Schema({
  _id: {
    type: String,
    default: () => "alumni_" + new mongoose.Types.ObjectId(),
  },
  status: { type: String, required: true, default: USER_STATUSES[ACTIVE] },
  tier: { type: Number, required: true, default: 0 },
  roles: { type: Array, required: true, default: [ALUMNI] },
  subscription: {
    period: { type: Number },
    id: { type: String },
    customerId: { type: String },
  },
  joinDate: { type: Date, default: new Date(), required: true },
  purchaseDate: { type: Date, default: new Date(), required: true },
  expireDate: { type: Date, required: true },
  image: { type: String, required: true },
  name: { type: String, required: true },
  surname: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true, minlength: 5 },
  quote: { type: String },
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
});

alumniUserSchema.plugin(uniqueValidator);

export default mongoose.model("AlumniUser", alumniUserSchema);
