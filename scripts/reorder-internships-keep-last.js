/**
 * Reorders internships by reassigning createdAt values so that, when the app
 * sorts by { createdAt: -1 }, all current entries are reversed except for the
 * current last entry, which remains last.
 *
 * Usage:
 *   node scripts/reorder-internships-keep-last.js
 *   node scripts/reorder-internships-keep-last.js --apply
 *   node scripts/reorder-internships-keep-last.js --env-file=.env.prod --apply
 *
 * By default, this runs in dry-run mode and only prints the proposed changes.
 */

import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const envFileArg = args.find((arg) => arg.startsWith("--env-file="));
const envFile = envFileArg
  ? path.resolve(__dirname, "..", envFileArg.split("=")[1])
  : path.resolve(__dirname, "..", ".env");

import dotenv from "dotenv";
dotenv.config({ path: envFile });

import mongoose from "mongoose";
import Internship from "../models/Internship.js";

const getMongoUri = () => {
  if (process.env.DB_READ_ACCESS_URI) {
    return process.env.DB_READ_ACCESS_URI;
  }

  if (process.env.DB_USER && process.env.DB_PASS && process.env.DB) {
    return `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;
  }

  throw new Error("Missing MongoDB connection details in environment variables.");
};

const buildDesiredOrder = (internships) => {
  if (internships.length <= 1) {
    return internships;
  }

  const lastInternship = internships[internships.length - 1];
  const reversedWithoutLast = internships.slice(0, -1).reverse();

  return [...reversedWithoutLast, lastInternship];
};

const formatEntry = (internship, index) =>
  `${String(index + 1).padStart(2, "0")}. ${internship.company} | ${internship.specialty} | ${internship._id}`;

const main = async () => {
  mongoose.set("strictQuery", true);
  await mongoose.connect(getMongoUri());

  try {
    const internships = await Internship.find()
      .sort({ createdAt: -1, _id: 1 })
      .select("_id company specialty createdAt")
      .lean();

    console.log(
      `[reorder-internships] Mode: ${apply ? "APPLY" : "DRY RUN"} | total=${internships.length}`
    );

    if (internships.length <= 1) {
      console.log("[reorder-internships] Nothing to reorder.");
      return;
    }

    const desiredOrder = buildDesiredOrder(internships);
    const createdAtSlots = internships.map((internship) => new Date(internship.createdAt));

    console.log("\n[reorder-internships] Current order");
    internships.forEach((internship, index) => {
      console.log(formatEntry(internship, index));
    });

    console.log("\n[reorder-internships] Proposed order");
    desiredOrder.forEach((internship, index) => {
      console.log(formatEntry(internship, index));
    });

    let updatedCount = 0;
    let unchangedCount = 0;

    for (const [index, internship] of desiredOrder.entries()) {
      const nextCreatedAt = createdAtSlots[index];
      const currentCreatedAt = new Date(internship.createdAt);
      const isUnchanged = currentCreatedAt.getTime() === nextCreatedAt.getTime();

      if (isUnchanged) {
        unchangedCount += 1;
        console.log(
          `[reorder-internships] Unchanged ${internship._id} | ${internship.company} | ${currentCreatedAt.toISOString()}`
        );
        continue;
      }

      if (apply) {
        await Internship.updateOne(
          { _id: internship._id },
          { $set: { createdAt: nextCreatedAt } }
        );
      }

      updatedCount += 1;
      console.log(
        `[reorder-internships] ${apply ? "Updated" : "Would update"} ${internship._id} | ` +
          `${internship.company} | ${currentCreatedAt.toISOString()} -> ${nextCreatedAt.toISOString()}`
      );
    }

    console.log(
      `\n[reorder-internships] Summary | updated=${updatedCount} unchanged=${unchangedCount}`
    );

    if (!apply) {
      console.log(
        "\nRun again with --apply to persist the internship order changes."
      );
    }
  } finally {
    await mongoose.connection.close();
  }
};

main().catch(async (err) => {
  console.error(`[reorder-internships] Failed: ${err.message}`);

  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }

  process.exitCode = 1;
});
