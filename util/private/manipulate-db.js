import moment from "moment";
import { MongoClient, ObjectId } from "mongodb";
import {
  ADMIN,
  BOARD_MEMBER,
  COMMITTEE_MEMBER,
  DELOITTE_TEMPLATE,
  MEMBER,
  PWC_TEMPLATE,
  VIP,
} from "../config/defines.js";
import User from "../../models/User.js";
import { sendMarketingEmail } from "../../services/side-services/email-transporter.js";

// Connection URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;

// Create a new MongoClient
const client = new MongoClient(uri);

export async function updateUsers() {
  try {
    // Connect to the MongoDB server
    await client.connect();
    console.log("Connected successfully to server");

    // Get the database and collection
    const database = client.db();
    const users = database.collection("users");
    const events = database.collection("events");

    const emailsToFind = [];

    // Find all users
    const cursor = users.find({ email: { $in: emailsToFind } });
    // const cursor = users.find();

    // // Iterate over all users
    for await (const user of cursor) {
      // Create a new object without the 'roles' property
      const newUserDoc = { ...user };

      // Find the position of 'status' and insert 'roles' after it
      const keys = Object.keys(newUserDoc);
      const statusIndex = keys.indexOf("status");

      // Convert fields to Date objects

      const newObj = {};
      keys.forEach((key, index) => {
        newObj[key] = newUserDoc[key];
      });

      newObj.roles = [BOARD_MEMBER];

      delete newUserDoc._id; // _id is immutable, so we remove it

      // Update the user
      const result = await users.replaceOne({ _id: user._id }, newObj);
      console.log(
        `Updated user ${user.name} ${user.surname} | ${user._id}: ${result.modifiedCount} document(s) modified`
      );
    }
  } catch (err) {
    console.log(err);
  } finally {
    console.log("Script executed successfully");
  }
}

export async function getMarketingUsers() {
  try {
    const today = new Date(); // Current date and time

    const clients = await User.find({
      expireDate: { $gte: today }, // $lt means "less than" (before today)
    }).select("email name"); // Select only email and name fields
    
    console.log(clients);

    clients.forEach(
      async (client) =>
        await sendMarketingEmail(PWC_TEMPLATE, client.email, client.name)
    );

    return clients;
  } catch (error) {
    console.error("Error fetching expired users:", error);
    return [];
  } finally {
    console.log("Done");
  }
}

export async function convertUserIdByEmail(email) {
  try {
    // Connect to the MongoDB server
    await client.connect();
    console.log("Connected successfully to server");

    // Get the database and collection
    const database = client.db();
    const users = database.collection("users");
    const alumniUsers = database.collection("alumniusers");
    
    // First, check if the user exists in either collection
    let user = await users.findOne({ email });
    let isAlumni = false;
    
    if (!user) {
      user = await alumniUsers.findOne({ email });
      isAlumni = true;
      
      if (!user) {
        console.log(`No user found with email: ${email}`);
        return null;
      }
    }
    
    // Original ID (with prefix)
    const originalId = user._id;
    console.log(`Original ID: ${originalId}`);
    
    // Extract the MongoDB ObjectId part from the string ID (after the prefix)
    const idMatch = originalId.match(/_(.*)/);
    if (!idMatch || !idMatch[1]) {
      console.log(`ID ${originalId} doesn't match the expected format.`);
      return null;
    }
    
    // Create a new MongoDB ObjectId from the extracted part
    const objectIdPart = idMatch[1];
    const newObjectId = new ObjectId(objectIdPart);
    console.log(`New ObjectId: ${newObjectId}`);
    
    // Create a new user object with the ObjectId
    const updatedUser = { ...user };
    delete updatedUser._id; // Remove the old _id
    
    // Update the user in the appropriate collection
    const collection = isAlumni ? alumniUsers : users;
    
    // First delete the original document with string ID to avoid duplicate key errors
    await collection.deleteOne({ _id: originalId });
    
    // Then insert the updated document with the new ObjectId
    await collection.insertOne({ _id: newObjectId, ...updatedUser });
    
    console.log(`Updated user with email ${email}: ID changed from ${originalId} to ${newObjectId}`);
    return { oldId: originalId, newId: newObjectId };
    
  } catch (error) {
    console.error("Error converting user ID:", error);
    return null;
  } finally {
    // Don't close the client here as it might be reused
    console.log("ID conversion process completed");
  }
}