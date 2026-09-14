import "dotenv/config";
import mongoose from "mongoose";
import Event from "../models/Event.js";
import EventDraft from "../models/EventDraft.js";

// Raw collection updates preserve historical timestamps and bypass schema
// immutability only for this one-time migration. No external services are called.
const filter = { lastUpdate: { $exists: true } };
const pipeline = [
  { $set: { metadata: { $mergeObjects: [
    { $ifNull: ["$metadata", {}] },
    {
      createdBy: { $ifNull: ["$metadata.createdBy", "$draftOwner.userId", null] },
      createdAt: { $ifNull: ["$metadata.createdAt", "$createdAt", null] },
      updatedBy: { $ifNull: ["$metadata.updatedBy", "$lastUpdate.id", null] },
      updatedAt: { $ifNull: ["$metadata.updatedAt", "$lastUpdate.timestamp", null] },
    },
  ] } } },
  { $unset: "lastUpdate" },
];

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply")) throw new Error("Unknown argument");
  if (!process.env.DB_USER || !process.env.DB_PASS || !process.env.DB) throw new Error("Missing database configuration");
  const apply = args.includes("--apply");
  mongoose.set("strictQuery", true);
  await mongoose.connect(`mongodb+srv://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASS)}@${process.env.DB}`, { serverSelectionTimeoutMS: 15000 });
  try {
    const collections = [Event.collection, EventDraft.collection];
    // Check both collections before applying either migration.
    for (const collection of collections) {
      const malformed = await collection.countDocuments({ ...filter, $expr: { $or: [
        { $not: [{ $in: [{ $type: "$metadata" }, ["object", "null", "missing"]] }] },
        { $not: [{ $in: [{ $type: "$lastUpdate" }, ["object", "null"]] }] },
      ] } });
      if (malformed) throw new Error(`Unexpected record shape in ${collection.collectionName}`);
    }
    const result = { mode: apply ? "apply" : "dry-run", database: mongoose.connection.name, collections: {} };
    for (const collection of collections) {
      const pending = await collection.countDocuments(filter);
      const modified = apply ? (await collection.updateMany(filter, pipeline)).modifiedCount : 0;
      result.collections[collection.collectionName] = { pending, modified, remaining: await collection.countDocuments(filter) };
    }
    console.log(JSON.stringify(result));
  } finally {
    await mongoose.disconnect();
  }
}
main().catch(async () => {
  console.error("Event metadata migration failed. Check database configuration and record shapes; no credentials or account data were printed.");
  process.exitCode = 1;
  await mongoose.disconnect();
});
