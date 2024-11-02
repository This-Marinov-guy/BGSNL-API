import mongoose from "mongoose";

export const accessCollectionDirectly = async () => {
  const uri = `mongodb+srv://spreadsheet_lazar:IAXWyCTEydKEzcm4@bgsnl.bskvjhq.mongodb.net`;

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
  console.log(documents);

  mongoose.disconnect();
};
