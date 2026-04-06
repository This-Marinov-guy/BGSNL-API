import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import { fileURLToPath } from "url";
import path from "path";
import User from "../models/User.js";
import AlumniUser from "../models/AlumniUser.js";
import { DEFAULT_REGION } from "../util/config/defines.js";
import { getStripeSubscriptionCreatedDate } from "../services/side-services/stripe.js";

const parseArgs = (argv) => {
  const options = {
    apply: false,
    model: "all",
    limit: null,
    email: null,
    id: null,
  };

  for (const arg of argv) {
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }

    if (arg.startsWith("--model=")) {
      options.model = arg.split("=")[1] || "all";
      continue;
    }

    if (arg.startsWith("--limit=")) {
      const parsedLimit = Number.parseInt(arg.split("=")[1], 10);
      options.limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null;
      continue;
    }

    if (arg.startsWith("--email=")) {
      options.email = arg.split("=")[1] || null;
      continue;
    }

    if (arg.startsWith("--id=")) {
      options.id = arg.split("=")[1] || null;
    }
  }

  return options;
};

const isDirectRun = (() => {
  const scriptPath = process.argv[1];

  if (!scriptPath) {
    return false;
  }

  return path.resolve(scriptPath) === fileURLToPath(import.meta.url);
})();

const buildQuery = (options) => {
  const query = {
    "subscription.id": {
      $exists: true,
      $nin: ["", null],
    },
  };

  if (options.email) {
    query.email = options.email;
  }

  if (options.id) {
    query._id = options.id;
  }

  return query;
};

const getPreferredRegions = (doc, type) => {
  if (type === "user") {
    return [doc.region, DEFAULT_REGION];
  }

  return [DEFAULT_REGION];
};

const processCollection = async (type, model, options) => {
  const query = buildQuery(options);
  let cursor = model
    .find(query)
    .select("_id email region joinDate subscription.id")
    .sort({ _id: 1 });

  if (options.limit) {
    cursor = cursor.limit(options.limit);
  }

  const docs = await cursor.lean();

  const summary = {
    type,
    scanned: docs.length,
    updated: 0,
    alreadyCorrect: 0,
    skippedMissingStripe: 0,
    errors: 0,
  };

  console.log(`\n[${type}] Processing ${docs.length} record(s)`);

  for (const doc of docs) {
    const subscriptionId = doc?.subscription?.id;

    try {
      const subscriptionData = await getStripeSubscriptionCreatedDate(
        subscriptionId,
        getPreferredRegions(doc, type)
      );

      if (!subscriptionData?.createdAt) {
        summary.skippedMissingStripe += 1;
        console.log(
          `[${type}] Skipped ${doc._id} (${doc.email}) | subscription ${subscriptionId} not found in Stripe`
        );
        continue;
      }

      const nextJoinDate = subscriptionData.createdAt;
      const currentJoinDate = doc.joinDate ? new Date(doc.joinDate) : null;
      const alreadyCorrect =
        currentJoinDate &&
        !Number.isNaN(currentJoinDate.getTime()) &&
        currentJoinDate.getTime() === nextJoinDate.getTime();

      if (alreadyCorrect) {
        summary.alreadyCorrect += 1;
        console.log(
          `[${type}] Unchanged ${doc._id} (${doc.email}) | ${nextJoinDate.toISOString()}`
        );
        continue;
      }

      if (options.apply) {
        await model.updateOne(
          { _id: doc._id },
          { $set: { joinDate: nextJoinDate } }
        );
      }

      summary.updated += 1;
      console.log(
        `[${type}] ${options.apply ? "Updated" : "Would update"} ${doc._id} (${doc.email}) | ` +
          `${currentJoinDate ? currentJoinDate.toISOString() : "missing"} -> ${nextJoinDate.toISOString()} | ` +
          `Stripe region: ${subscriptionData.region}`
      );
    } catch (err) {
      summary.errors += 1;
      console.error(
        `[${type}] Error processing ${doc._id} (${doc.email}) | ${err.message}`
      );
    }
  }

  return summary;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const validModels = new Set(["all", "user", "alumni"]);

  if (!validModels.has(options.model)) {
    throw new Error(`Invalid --model value "${options.model}". Use all, user, or alumni.`);
  }

  mongoose.set("strictQuery", true);
  await mongoose.connect(
    `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`
  );

  console.log(
    `[repair-join-dates] Mode: ${options.apply ? "APPLY" : "DRY RUN"} | model=${options.model}` +
      `${options.limit ? ` | limit=${options.limit}` : ""}` +
      `${options.email ? ` | email=${options.email}` : ""}` +
      `${options.id ? ` | id=${options.id}` : ""}`
  );

  const summaries = [];

  try {
    if (options.model === "all" || options.model === "user") {
      summaries.push(await processCollection("user", User, options));
    }

    if (options.model === "all" || options.model === "alumni") {
      summaries.push(await processCollection("alumni", AlumniUser, options));
    }
  } finally {
    await mongoose.connection.close();
  }

  console.log("\n[repair-join-dates] Summary");
  for (const summary of summaries) {
    console.log(
      `[${summary.type}] scanned=${summary.scanned} updated=${summary.updated} alreadyCorrect=${summary.alreadyCorrect} ` +
        `skippedMissingStripe=${summary.skippedMissingStripe} errors=${summary.errors}`
    );
  }

  if (!options.apply) {
    console.log("\nRun again with --apply to persist the joinDate updates.");
  }
};

if (isDirectRun) {
  main().catch(async (err) => {
    console.error(`[repair-join-dates] Failed: ${err.message}`);

    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }

    process.exitCode = 1;
  });
}
