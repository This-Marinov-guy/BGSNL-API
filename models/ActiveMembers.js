import mongoose from "mongoose";
import uniqueValidator from "mongoose-unique-validator";

const Schema = mongoose.Schema;

const activeMemberSchema = new Schema({
    timestamp: { type: String },
    positions: { type: Array },
    date: { type: Array },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    cv: { type: String },
    letter: { type: String },
    questions: {
        q1: { type: String, },
        q2: { type: String, },
        q3: { type: String, },
        q4: { type: String, },
        q5: { type: String, },
        q6: { type: String, },
        q7: { type: String, },
        q8: { type: String, },
        q9: { type: String, },
        q10: { type: String, },
    }
});

activeMemberSchema.plugin(uniqueValidator);

export default mongoose.model("ActiveMember", activeMemberSchema);
