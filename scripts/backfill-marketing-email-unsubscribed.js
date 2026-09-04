import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import MarketingEmail from "../models/MarketingEmail.js";

const getMongoUri = () =>
  // eslint-disable-next-line no-process-env
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;

const main = async () => {
  const apply = process.argv.slice(2).includes("--apply");

  mongoose.set("strictQuery", true);
  await mongoose.connect(getMongoUri(), {
    autoCreate: false,
    autoIndex: false,
  });

  try {
    const missingQuery = { unsubscribed: { $exists: false } };
    const [total, missing, subscribed, unsubscribed] = await Promise.all([
      MarketingEmail.countDocuments(),
      MarketingEmail.countDocuments(missingQuery),
      MarketingEmail.countDocuments({ unsubscribed: false }),
      MarketingEmail.countDocuments({ unsubscribed: true }),
    ]);

    console.log(
      `[marketing-unsubscribed-backfill] Mode=${apply ? "APPLY" : "DRY RUN"} ` +
        `total=${total} missing=${missing} subscribed=${subscribed} unsubscribed=${unsubscribed}`
    );

    if (!apply) {
      console.log(`[result] Would set unsubscribed=false on ${missing} record(s).`);
      return;
    }

    const result = await MarketingEmail.updateMany(missingQuery, {
      $set: { unsubscribed: false },
    });

    await MarketingEmail.createIndexes();

    const [remainingMissing, finalSubscribed, finalUnsubscribed] =
      await Promise.all([
        MarketingEmail.countDocuments(missingQuery),
        MarketingEmail.countDocuments({ unsubscribed: false }),
        MarketingEmail.countDocuments({ unsubscribed: true }),
      ]);

    if (remainingMissing !== 0 || finalSubscribed + finalUnsubscribed !== total) {
      throw new Error("Post-backfill verification failed");
    }

    console.log(
      `[result] modified=${result.modifiedCount} remainingMissing=${remainingMissing} ` +
        `subscribed=${finalSubscribed} unsubscribed=${finalUnsubscribed}`
    );
  } finally {
    await mongoose.connection.close();
  }
};

main().catch(async (error) => {
  console.error(`[marketing-unsubscribed-backfill] Failed: ${error.message}`);

  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }

  process.exitCode = 1;
});
