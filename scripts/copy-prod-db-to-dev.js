import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

// Replaces the dev database with a copy of production.
//
// The direction is hardcoded: source is always .env.prod, target is always
// .env.dev. Neither is taken from the ambient environment and there is no flag
// to swap them, so this cannot run backwards onto production. A guard also
// refuses to run when both files resolve to the same host.
//
// Collections are copied under the names production currently uses (users,
// alumniusers, ...). The camelCase renames are applied afterwards by
// migrations/run.js against dev only.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ENV = path.join(ROOT, ".env.prod");
const TARGET_ENV = path.join(ROOT, ".env.dev");
const BATCH_SIZE = 1000;
// Migration bookkeeping is per-environment and must not be inherited.
const SKIP_COLLECTIONS = new Set(["_migrations"]);

const readEnv = (file) => {
  const parsed = dotenv.parse(readFileSync(file));
  for (const key of ["DB", "DB_USER", "DB_PASS"]) {
    if (!parsed[key]) throw new Error(`${path.basename(file)} is missing ${key}`);
  }
  return {
    uri: `mongodb+srv://${parsed.DB_USER}:${parsed.DB_PASS}@${parsed.DB}`,
    host: parsed.DB.split("/")[0],
    user: parsed.DB_USER,
  };
};

const indexSpecsFrom = (indexes) =>
  indexes
    .filter((index) => index.name !== "_id_")
    .map(({ key, name, unique, sparse, expireAfterSeconds, partialFilterExpression, collation, weights }) => {
      const spec = { key, name };
      if (unique) spec.unique = true;
      if (sparse) spec.sparse = true;
      if (expireAfterSeconds !== undefined) spec.expireAfterSeconds = expireAfterSeconds;
      if (partialFilterExpression) spec.partialFilterExpression = partialFilterExpression;
      if (collation) spec.collation = collation;
      if (weights) spec.weights = weights;
      return spec;
    });

const copyCollection = async (sourceDb, targetDb, name, apply) => {
  const sourceCollection = sourceDb.collection(name);
  const [count, indexes] = await Promise.all([
    sourceCollection.countDocuments(),
    sourceCollection.indexes(),
  ]);
  const specs = indexSpecsFrom(indexes);

  const targetExists =
    (await targetDb.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
  const targetCount = targetExists ? await targetDb.collection(name).countDocuments() : 0;

  if (!apply) {
    console.log(
      `[plan] ${name}: copy ${count} doc(s) + ${specs.length} index(es); ` +
        (targetExists ? `replaces existing dev collection holding ${targetCount} doc(s).` : "dev has no such collection.")
    );
    return { name, count };
  }

  if (targetExists) await targetDb.collection(name).drop();
  await targetDb.createCollection(name);
  const targetCollection = targetDb.collection(name);

  let copied = 0;
  const cursor = sourceCollection.find({});
  let batch = [];
  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= BATCH_SIZE) {
      await targetCollection.insertMany(batch, { ordered: false });
      copied += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    await targetCollection.insertMany(batch, { ordered: false });
    copied += batch.length;
  }

  if (specs.length) await targetCollection.createIndexes(specs);

  const verified = await targetCollection.countDocuments();
  if (verified !== count) {
    throw new Error(`${name}: copied ${verified} documents but source has ${count}.`);
  }

  console.log(`[done] ${name}: ${verified} doc(s), ${specs.length} index(es) recreated.`);
  return { name, count: verified };
};

const main = async () => {
  const apply = process.argv.slice(2).includes("--apply");
  const source = readEnv(SOURCE_ENV);
  const target = readEnv(TARGET_ENV);

  if (source.host === target.host) {
    throw new Error(
      `Refusing to run: .env.prod and .env.dev both point at ${source.host}. They must be different clusters.`
    );
  }

  const sourceClient = new MongoClient(source.uri);
  const targetClient = new MongoClient(target.uri);

  try {
    await Promise.all([sourceClient.connect(), targetClient.connect()]);
    const sourceDb = sourceClient.db();
    const targetDb = targetClient.db();

    console.log(`[copy-prod-to-dev] Mode=${apply ? "APPLY" : "DRY RUN"}`);
    console.log(`[source] ${source.user}@${source.host} db=${sourceDb.databaseName}`);
    console.log(`[target] ${target.user}@${target.host} db=${targetDb.databaseName}`);

    const names = (await sourceDb.listCollections({}, { nameOnly: true }).toArray())
      .map((item) => item.name)
      .filter((name) => !SKIP_COLLECTIONS.has(name) && !name.startsWith("system."))
      .sort();

    const orphans = (await targetDb.listCollections({}, { nameOnly: true }).toArray())
      .map((item) => item.name)
      .filter((name) => !names.includes(name) && !SKIP_COLLECTIONS.has(name) && !name.startsWith("system."));

    let total = 0;
    for (const name of names) {
      const result = await copyCollection(sourceDb, targetDb, name, apply);
      total += result.count;
    }

    if (orphans.length) {
      console.log(`[note] dev has collections absent from prod, left untouched: ${orphans.join(", ")}`);
    }

    console.log(
      apply
        ? `[result] Copied ${names.length} collection(s), ${total} document(s) into dev.`
        : `[result] Would copy ${names.length} collection(s), ${total} document(s) into dev.`
    );
  } finally {
    await Promise.allSettled([sourceClient.close(), targetClient.close()]);
  }
};

main().catch((error) => {
  console.error(`[copy-prod-to-dev] Failed: ${error.message}`);
  process.exitCode = 1;
});
