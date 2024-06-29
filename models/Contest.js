import mongoose from "mongoose";

const Schema = mongoose.Schema;

const contestSchema = new Schema({
    contestName: { type: String },
    registered: [
        {
            timestamp: { type: String },
            name: { type: String, required: true },
            surname: { type: String, required: true },
            email: { type: String, required: true },
            comments: { type: String }
        },
    ],
});

contestSchema.static(
    "findOneOrCreate",
    async function findOneOrCreate(condition, doc) {
        const one = await this.findOne(condition);

        return one || this.create(doc);
    }
);

export default mongoose.model("Contest", contestSchema);
