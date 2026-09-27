import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";

const SOURCE_COLLECTION = "marketing_emails";
const TARGET_COLLECTION = "marketingEmails";

const getMongoUri = () =>
  // eslint-disable-next-line no-process-env
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;

const collectionExists = async (db, name) => {
  const collections = await db
    .listCollections({ name }, { nameOnly: true })
    .toArray();
  return collections.length > 0;
};

const getCollectionSummary = async (db, name) => {
  if (!(await collectionExists(db, name))) return null;

  const collection = db.collection(name);
  const [count, indexes] = await Promise.all([
    collection.countDocuments(),
    collection.indexes(),
  ]);

  return {
    count,
    indexes: indexes.map((index) => index.name).sort(),
  };
};

const main = async () => {
  const apply = process.argv.slice(2).includes("--apply");

  mongoose.set("strictQuery", true);
  await mongoose.connect(getMongoUri(), {
    autoCreate: false,
    autoIndex: false,
  });

  try {
    const db = mongoose.connection.db;
    const source = await getCollectionSummary(db, SOURCE_COLLECTION);
    const target = await getCollectionSummary(db, TARGET_COLLECTION);

    console.log(
      `[marketing-collection-rename] Mode=${apply ? "APPLY" : "DRY RUN"}`
    );
    console.log(
      `[source] ${SOURCE_COLLECTION} ${
        source
          ? `count=${source.count} indexes=${source.indexes.join(",")}`
          : "missing"
      }`
    );
    console.log(
      `[target] ${TARGET_COLLECTION} ${
        target
          ? `count=${target.count} indexes=${target.indexes.join(",")}`
          : "missing"
      }`
    );

    if (!source && target) {
      console.log("[result] Collection is already renamed.");
      return;
    }

    if (!source) {
      throw new Error(`Source collection does not exist: ${SOURCE_COLLECTION}`);
    }

    if (target) {
      throw new Error(
        `Target collection already exists: ${TARGET_COLLECTION}. Refusing to overwrite it.`
      );
    }

    if (!apply) {
      console.log(
        `[result] Would rename ${SOURCE_COLLECTION} to ${TARGET_COLLECTION}.`
      );
      return;
    }

    await db.collection(SOURCE_COLLECTION).rename(TARGET_COLLECTION);

    const renamed = await getCollectionSummary(db, TARGET_COLLECTION);
    const oldStillExists = await collectionExists(db, SOURCE_COLLECTION);

    if (!renamed || renamed.count !== source.count || oldStillExists) {
      throw new Error("Post-rename verification failed");
    }

    console.log(
      `[result] Renamed successfully count=${renamed.count} indexes=${renamed.indexes.join(",")}`
    );
  } finally {
    await mongoose.connection.close();
  }
};

main().catch(async (error) => {
  console.error(`[marketing-collection-rename] Failed: ${error.message}`);

  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }

  process.exitCode = 1;
});
