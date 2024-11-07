import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

export const readDatabaseCollection = async (req, res, next) => {
  const uri = `mongodb+srv://${process.env.DB_LAZAR_USERNAME}:${process.env.DB_LAZAR_PASS}@${process.env.DB_CLEAN}`;
  const collection = req.params.collection;  

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

  try {
    const items = db.collection(collection);

    const documents = await items.find({}).toArray();

    mongoose.disconnect();

    return res.status(200).json({
      status: true,
      data: documents,
    });
  } catch (err) {
    console.log(err);

    mongoose.disconnect();

    return res.status(500).json({
      status: false,
      message: "Error while fetching collection, please make sure it exists!",
    });
  }
};
