import mongoose from "mongoose";
import dotenv from "dotenv";
import Event from "../../models/Event.js";
import MemberUser from "../../models/MemberUser.js";
dotenv.config();

// TODO: find a way to make this work with 2 db connections
// export const readDatabaseCollection = async (req, res, next) => {
//   const uri = `mongodb+srv://${process.env.DB_LAZAR_USERNAME}:${process.env.DB_LAZAR_PASS}@${process.env.DB_CLEAN}`;
//   const collection = req.params.collection;

//   try {
//     mongoose.disconnect();

//     await mongoose.connect(uri, {
//       useNewUrlParser: true,
//       useUnifiedTopology: true,
//     });
//     console.log(
//       `Connected to DB Read-only from: ${req.ip} | ${req.headers.origin}`
//     );
//   } catch (err) {
//     console.log(err);
//   }

//   const db = mongoose.connection;

//   try {
//     const items = db.collection(collection);

//     const documents = await items.find({}).toArray();

//     mongoose.disconnect();

//     return res.status(200).json({
//       status: true,
//       data: documents,
//     });
//   } catch (err) {
//     console.log(err);

//     mongoose.disconnect();

//     return res.status(500).json({
//       status: false,
//       message: "Error while fetching collection, please make sure it exists!",
//     });
//   }
// };

export const readDatabaseCollection = async (req, res, next) => {
  const collection = req.params.collection;

  try {
    let documents;

    switch (collection) {
      case "events":
        documents = await Event.find({}).select([
          "_id", "region", "title", "date", "correctedDate", "location",
          "status", "ticketTimer", "ticketLimit", "isSaleClosed", "isFree",
          "isMemberFree", "memberOnly", "hidden", "createdAt", "metadata.updatedAt",
        ].join(" ")).lean();
        break;
      case "users":
        // Explicitly allow only the fields required by the spreadsheet import.
        // Do not add account credentials, roles, subscription, documents,
        // tickets, campaign state, recovery/session fields or arbitrary model data.
        documents = await MemberUser.find({}).select([
          "_id", "name", "surname", "email", "phone", "region", "status",
          "university", "otherUniversityName", "graduationDate", "course",
          "profession", "joinDate", "purchaseDate", "expireDate",
        ].join(" ")).lean();
        break;
      default:
        throw new Error();
    }

    return res.status(200).json({
      status: true,
      data: documents,
    });
  } catch (err) {
    console.log(err);

    return res.status(500).json({
      status: false,
      message: "Error while fetching collection, please make sure it exists!",
    });
  }
};
