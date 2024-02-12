import mongoose from "mongoose";
import uniqueValidator from "mongoose-unique-validator";

const Schema = mongoose.Schema;

const userSchema = new Schema({
  status: { type: String, required: true },
  region: { type: String },
  purchaseDate: { type: String },
  expireDate: { type: String },
  image: { type: String, required: true },
  name: { type: String, required: true },
  surname: { type: String, required: true },
  birth: { type: String, required: true },
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
      purchaseDate: { type: String },
      image: { type: String, required: true },
    },
  ],
  christmas: [
    {
      sender: { type: String },
      receiver: { type: String },
      text: { type: String, required: true },
      gif: { type: String },
    }
  ]
});

userSchema.plugin(uniqueValidator);

export default mongoose.model("User", userSchema);
