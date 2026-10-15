import { ObjectId } from "mongodb";
import { DEFAULT_REGION } from "../util/config/defines.js";

const mappings = [
  ["eventEmailCampaigns", "events", "emailCampaigns", "eventId"],
];

const exists = async (db, name) => (await db.listCollections({ name }).toArray()).length > 0;
const parentId = value => typeof value === "string" && ObjectId.isValid(value) && String(new ObjectId(value)) === value
  ? new ObjectId(value) : value;

async function embedCollection(db, [sourceName, parentName, field, parentField]) {
  if (!await exists(db, sourceName)) return;
  const source = db.collection(sourceName);
  const parents = db.collection(parentName);
  const total = await source.countDocuments();
  let copied = 0;
  for await (const record of source.find({})) {
    if (record._id == null || record[parentField] == null) throw new Error(`${sourceName} has a record without its parent identity`);
    const _id = parentId(record[parentField]);
    const result = await parents.updateOne({ _id, [`${field}._id`]: { $ne: record._id } }, { $push: { [field]: record } });
    if (!result.modifiedCount && !await parents.findOne({ _id, [`${field}._id`]: record._id }, { projection: { _id: 1 } })) {
      throw new Error(`${sourceName} has a missing parent in ${parentName}`);
    }
    copied++;
  }
  if (copied !== total || copied !== await source.countDocuments()) throw new Error(`${sourceName} changed during migration`);
  for await (const record of source.find({}, { projection: { _id: 1, [parentField]: 1 } })) {
    if (!await parents.findOne({ _id: parentId(record[parentField]), [`${field}._id`]: record._id }, { projection: { _id: 1 } })) {
      throw new Error(`${sourceName} could not be verified in ${parentName}`);
    }
  }
  await source.drop();
}

async function moveDeletedDrafts(db) {
  const sourceName = "eventMediaCleanups";
  if (!await exists(db, sourceName)) return;
  const source = db.collection(sourceName);
  const drafts = db.collection("eventDrafts");
  const total = await source.countDocuments();
  let copied = 0;
  for await (const record of source.find({})) {
    if (record.clearedAt) { copied++; continue; }
    const rawId = String(record._id || "").replace(/^draft:/, "");
    if (!String(record._id).startsWith("draft:") || !ObjectId.isValid(rawId) || !record.folder ||
      !Number.isFinite(new Date(record.dueAt).getTime())) throw new Error("Invalid pending deleted-draft media record");
    const _id = new ObjectId(rawId);
    const current = await drafts.findOne({ _id }, { projection: { folder: 1 } });
    if (current?.folder && current.folder !== record.folder) throw new Error("Deleted-draft media folder changed");
    await drafts.updateOne({ _id }, { $set: { folder: record.folder, deletedAt: record.createdAt || new Date(),
      mediaCleanupDueAt: record.dueAt, ...(record.retryAt ? { mediaCleanupRetryAt: record.retryAt } : {}) },
      $setOnInsert: { status: "draft", region: DEFAULT_REGION, createdAt: record.createdAt || new Date() } }, { upsert: true });
    copied++;
  }
  if (copied !== total || copied !== await source.countDocuments()) throw new Error("Deleted-draft media records changed during migration");
  await source.drop();
}

export default {
  id: "015-embed-tracking-records",
  async up(db) {
    for (const mapping of mappings) await embedCollection(db, mapping);
    await moveDeletedDrafts(db);
  },
};
