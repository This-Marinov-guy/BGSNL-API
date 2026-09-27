import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";

// Reverts the "users" -> "memberUsers" rename. The deployed production API
// still runs the old code, which reads from "users", so the collection has to
// carry that name until the renamed code actually ships.
//
// The 001 migration's tracking record is removed alongside the rename: the
// runner skips any id already present in _migrations, so leaving the record
// behind would make the next deploy ship memberUsers-expecting code against a
// collection named "users" without ever renaming it.
const SOURCE_COLLECTION = "memberUsers";
const TARGET_COLLECTION = "users";
const MIGRATION_ID = "001-rename-users-to-member-users";
const TRACKING_COLLECTION = "_migrations";

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

  return { count, indexes: indexes.map((index) => index.name).sort() };
};

const main = async () => {
  const apply = process.argv.slice(2).includes("--apply");

  mongoose.set("strictQuery", true);
  await mongoose.connect(getMongoUri(), { autoCreate: false, autoIndex: false });

  try {
    const db = mongoose.connection.db;
    const source = await getCollectionSummary(db, SOURCE_COLLECTION);
    const target = await getCollectionSummary(db, TARGET_COLLECTION);
    const tracked = await db
      .collection(TRACKING_COLLECTION)
      .findOne({ _id: MIGRATION_ID });

    console.log(
      `[revert-member-users] database=${mongoose.connection.name} Mode=${apply ? "APPLY" : "DRY RUN"}`
    );
    console.log(
      `[source] ${SOURCE_COLLECTION} ${source ? `count=${source.count} indexes=${source.indexes.join(",")}` : "missing"}`
    );
    console.log(
      `[target] ${TARGET_COLLECTION} ${target ? `count=${target.count} indexes=${target.indexes.join(",")}` : "missing"}`
    );
    console.log(`[tracking] ${MIGRATION_ID} ${tracked ? "recorded as applied" : "not recorded"}`);

    if (!source && target) {
      console.log("[result] Collection is already named users; nothing to rename.");
    } else if (!source) {
      throw new Error(`Source collection does not exist: ${SOURCE_COLLECTION}`);
    } else {
      // A placeholder can be auto-created by any Mongoose model that registers
      // under the target name. Empty means safe to drop; anything with data is
      // real and must not be overwritten.
      if (target && target.count > 0) {
        throw new Error(
          `Target collection already exists with data: ${TARGET_COLLECTION} (count=${target.count}). Refusing to overwrite it.`
        );
      }

      if (!apply) {
        console.log(
          target
            ? `[result] Would drop the empty placeholder ${TARGET_COLLECTION}, then rename ${SOURCE_COLLECTION} to ${TARGET_COLLECTION}.`
            : `[result] Would rename ${SOURCE_COLLECTION} to ${TARGET_COLLECTION}.`
        );
      } else {
        if (target) {
          await db.collection(TARGET_COLLECTION).drop();
          console.log(`[step] Dropped empty placeholder collection ${TARGET_COLLECTION}.`);
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
      }
    }

    if (tracked) {
      if (!apply) {
        console.log(`[result] Would remove the ${MIGRATION_ID} record from ${TRACKING_COLLECTION}.`);
      } else {
        await db.collection(TRACKING_COLLECTION).deleteOne({ _id: MIGRATION_ID });
        console.log(`[step] Removed ${MIGRATION_ID} from ${TRACKING_COLLECTION}; it will run again on the next deploy.`);
      }
    }
  } finally {
    await mongoose.connection.close();
  }
};

main().catch(async (error) => {
  console.error(`[revert-member-users] Failed: ${error.message}`);

  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }

  process.exitCode = 1;
});
