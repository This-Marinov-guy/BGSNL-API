import "dotenv/config";
import { readdir, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MongoClient } from "mongodb";
import { runMigrations, recoverMigrationRun, safeError } from "../services/migrations/runner.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line no-process-env
const env = process.env;
const secrets = [env.DB_PASS, env.DB_USER, env.MIGRATION_MONGO_URI];
const signal = new AbortController();
process.once("SIGTERM", () => signal.abort());
process.once("SIGINT", () => signal.abort());

async function loadMigrations() {
  const files = (await readdir(directory)).filter(file => /^\d+-.+\.js$/.test(file)).sort();
  return Promise.all(files.map(async file => {
    const migration = (await import(pathToFileURL(path.join(directory, file)).href)).default;
    if (!migration || typeof migration.id !== "string" || typeof migration.up !== "function") throw new Error(`${file} must export default { id, up(db) }`);
    return migration;
  }));
}

async function saveResult(result) {
  if (!env.MIGRATION_OUTPUT_DIR) return;
  await mkdir(env.MIGRATION_OUTPUT_DIR, { recursive: true, mode: 0o700 });
  await writeFile(path.join(env.MIGRATION_OUTPUT_DIR, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  // Written last: the deployment script must never resume an old API based only
  // on an exit code or incomplete output from a killed migration process.
  if (result.safeToResume) await writeFile(path.join(env.MIGRATION_OUTPUT_DIR, "rollback.status"), "rolled-back\n", { mode: 0o600 });
}

async function main() {
  // Never let a reused output directory carry an old safe-to-resume marker.
  if (env.MIGRATION_OUTPUT_DIR) {
    await rm(path.join(env.MIGRATION_OUTPUT_DIR, "rollback.status"), { force: true });
    await rm(path.join(env.MIGRATION_OUTPUT_DIR, "result.json"), { force: true });
  }
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--writers-stopped" && !/^--recover=[a-f\d-]{36}$/.test(arg))) throw new Error("Use --writers-stopped, optionally with --recover=<run-id>");
  if (!args.includes("--writers-stopped")) throw new Error("Stop database writers and pass --writers-stopped before migrating");
  const recovery = args.find(arg => arg.startsWith("--recover="))?.slice(10);
  let uri = env.MIGRATION_MONGO_URI;
  if (!uri) {
    if (!env.DB_USER || !env.DB_PASS || !env.DB) throw new Error("Missing migration database configuration");
    uri = `mongodb+srv://${encodeURIComponent(env.DB_USER)}:${encodeURIComponent(env.DB_PASS)}@${env.DB}`;
  }
  const migrations = recovery ? null : await loadMigrations();
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, readPreference: "primary", writeConcern: { w: "majority" } });
  try {
    await client.connect();
    const options = { writersStopped: true, signal: signal.signal, secrets, revision: env.DEPLOY_REVISION || "unknown" };
    const result = recovery ? await recoverMigrationRun(client.db(), recovery, options) : await runMigrations(client.db(), migrations, options);
    if (recovery) console.log(JSON.stringify({ phase: "recovery-result", ...result }));
    await saveResult(result);
  } catch (error) {
    const result = error.result || { status: "blocked", safeToResume: false };
    console.error(JSON.stringify({ phase: "runner-failed", ...result, error: safeError(error.cause || error, secrets) }));
    await saveResult(result);
    process.exitCode = 1;
  } finally { await client.close(); }
}

main().catch(error => {
  console.error(JSON.stringify({ phase: "startup-failed", error: safeError(error, secrets) }));
  process.exitCode = 1;
});
