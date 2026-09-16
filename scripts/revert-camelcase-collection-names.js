import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";

// Reverts the 002 camelCase renames. The deployed production API still runs
// the old code, which reads the lowercase names, so the collections have to
// carry those names until the renamed code actually ships.
//
// "eventDrafts" and "marketingEmails" are deliberately absent: both were
// already camelCase before this change and must not be touched.
//
// The 002 tracking record is removed alongside the renames, since the runner
// skips any id already present in _migrations and the migration still needs
// to run on the deploy that ships the renamed code.
const RENAMES = [
  ["activeMembers", "activemembers"],
  ["alumniUsers", "alumniusers"],
  ["internshipApplications", "internshipapplications"],
  ["nonSocietyEvents", "nonsocietyevents"],
  ["supportConversations", "supportconversations"],
  ["temporaryCodes", "temporarycodes"],
];
const MIGRATION_ID = "002-camelcase-collection-names";
const TRACKING_COLLECTION = "_migrations";

const getMongoUri = () =>
  // eslint-disable-next-line no-process-env
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;

const collectionExists = async (db, name) =>
  (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;

const revertOne = async (db, source, target, apply) => {
  const sourceExists = await collectionExists(db, source);
  const targetExists = await collectionExists(db, target);

  if (!sourceExists) {
    console.log(
      targetExists
        ? `[skip] ${source} is gone and ${target} already exists; nothing to do.`
        : `[skip] neither ${source} nor ${target} exists.`
    );
    return;
  }

  const sourceCount = await db.collection(source).countDocuments();

  if (targetExists) {
    const targetCount = await db.collection(target).countDocuments();
    if (targetCount > 0) {
      throw new Error(
        `Target collection already exists with data: ${target} (count=${targetCount}). Refusing to overwrite it.`
      );
    }

    if (!apply) {
      console.log(`[plan] Would drop the empty placeholder ${target}, then rename ${source} -> ${target} (${sourceCount} docs).`);
      return;
    }

    await db.collection(target).drop();
    console.log(`[step] Dropped empty placeholder collection ${target}.`);
  } else if (!apply) {
    console.log(`[plan] Would rename ${source} -> ${target} (${sourceCount} docs).`);
    return;
  }

  await db.collection(source).rename(target);

  const renamedCount = await db.collection(target).countDocuments();
  if (renamedCount !== sourceCount || (await collectionExists(db, source))) {
    throw new Error(`Post-rename verification failed for ${target}: expected ${sourceCount}, got ${renamedCount}.`);
  }

  console.log(`[done] Renamed ${source} -> ${target} (${renamedCount} docs).`);
};

const main = async () => {
  const apply = process.argv.slice(2).includes("--apply");

  mongoose.set("strictQuery", true);
  await mongoose.connect(getMongoUri(), { autoCreate: false, autoIndex: false });

  try {
    const db = mongoose.connection.db;
    console.log(
      `[revert-camelcase] database=${mongoose.connection.name} Mode=${apply ? "APPLY" : "DRY RUN"}`
    );

    for (const [source, target] of RENAMES) {
      await revertOne(db, source, target, apply);
    }

    const tracked = await db.collection(TRACKING_COLLECTION).findOne({ _id: MIGRATION_ID });
    if (!tracked) {
      console.log(`[tracking] ${MIGRATION_ID} is not recorded; nothing to remove.`);
    } else if (!apply) {
      console.log(`[plan] Would remove the ${MIGRATION_ID} record from ${TRACKING_COLLECTION}.`);
    } else {
      await db.collection(TRACKING_COLLECTION).deleteOne({ _id: MIGRATION_ID });
      console.log(`[step] Removed ${MIGRATION_ID} from ${TRACKING_COLLECTION}; it will run again on the next deploy.`);
    }
  } finally {
    await mongoose.connection.close();
  }
};

main().catch(async (error) => {
  console.error(`[revert-camelcase] Failed: ${error.message}`);

  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }

  process.exitCode = 1;
});
