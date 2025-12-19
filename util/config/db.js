import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

export const accessCollectionDirectly = async () => {
  const uri = process.env.DB_READ_ACCESS_URI;

  try {
    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("Connected to DB Read only");
  } catch (err) {
    console.log(err);
  }

  const db = mongoose.connection;

  const events = db.collection("events");

  const documents = await events.find({}).toArray();

  mongoose.disconnect();
};
