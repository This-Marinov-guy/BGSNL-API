import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import User from '../../../models/User.js';

dotenv.config();

const uri = process.env.DB_TOOLS_STRING;
const dbName = 'test';
const collectionName = 'events';

export async function fetchEventsFromDB() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    const db = client.db(dbName);
    const collection = db.collection(collectionName);
    return await collection.find({ hidden: false }).toArray();
  } catch (err) {
    console.error('Error fetching events from MongoDB:', err);
    return [];
  } finally {
    await client.close();
  }
}

export async function fetchMMCampaignUsers() {
  const users = await User.find({
    "mmmCampaign2025.calendarImage": { $ne: "" },
  });

  console.log('Users:', users.length);
}
