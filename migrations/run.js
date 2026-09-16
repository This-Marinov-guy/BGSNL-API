import dotenv from "dotenv";
dotenv.config();

import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import mongoose from "mongoose";

/**
 * Deploy-time migration runner.
 *
 * Every file in this directory (other than this one) must export
 * `{ id, up(db) }`. Each migration runs at most once: after it completes,
 * its id is recorded in the `_migrations` collection, and future runs skip
 * it. Migrations run in filename order, so name them "001-...", "002-...".
 *
 * A migration that throws stops the whole run with a non-zero exit code.
 * Wired into .github/workflows/docker-ci-cd.yml to run against the freshly
 * built image before the live container is replaced, so a failed migration
 * blocks the deploy instead of shipping code the database isn't ready for.
 */

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url));
const TRACKING_COLLECTION = "_migrations";

const getMongoUri = () =>
  // eslint-disable-next-line no-process-env
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;

const loadMigrations = async () => {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js") && entry.name !== "run.js")
    .map((entry) => entry.name)
    .sort();

  const migrations = [];
  for (const file of files) {
    const module = await import(pathToFileURL(path.join(MIGRATIONS_DIR, file)).href);
    const migration = module.default;
    if (!migration || typeof migration.id !== "string" || typeof migration.up !== "function") {
      throw new Error(`${file} must export default { id, up(db) }`);
    }
    migrations.push(migration);
  }
  return migrations;
};

const main = async () => {
  mongoose.set("strictQuery", true);
  await mongoose.connect(getMongoUri(), { autoCreate: false, autoIndex: false });

  try {
    const db = mongoose.connection.db;
    const tracking = db.collection(TRACKING_COLLECTION);
    const migrations = await loadMigrations();

    if (!migrations.length) {
      console.log("[migrations] No migration files found.");
      return;
    }

    const applied = new Set(
      (await tracking.find({}, { projection: { _id: 1 } }).toArray()).map((doc) => doc._id)
    );

    for (const migration of migrations) {
      if (applied.has(migration.id)) {
        console.log(`[migrations] Skipping ${migration.id} (already applied).`);
        continue;
      }

      console.log(`[migrations] Applying ${migration.id}...`);
      await migration.up(db);
      await tracking.insertOne({ _id: migration.id, appliedAt: new Date() });
      console.log(`[migrations] Applied ${migration.id}.`);
    }
  } finally {
    await mongoose.connection.close();
  }
};

main().catch(async (error) => {
  console.error(`[migrations] Failed: ${error.message}`);
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
  process.exitCode = 1;
});
