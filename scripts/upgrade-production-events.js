import "dotenv/config";
import mongoose from "mongoose";
import { upgradeProductionEvents } from "../services/events/event-production-upgrade.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--apply", "--dry-run", "--writers-stopped"].includes(arg)) || (args.includes("--apply") && args.includes("--dry-run"))) throw new Error("Use either --dry-run (default) or --apply --writers-stopped.");
  if (args.includes("--apply") && !args.includes("--writers-stopped")) throw new Error("Stop database writers and pass --writers-stopped before applying.");
  // eslint-disable-next-line no-process-env
  const { DB_USER, DB_PASS, DB } = process.env;
  if (!DB_USER || !DB_PASS || !DB) throw new Error("Missing database configuration.");
  mongoose.set("strictQuery", true);
  try {
    await mongoose.connect(`mongodb+srv://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASS)}@${DB}`, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 15000, readPreference: "primary", writeConcern: { w: "majority" } });
    console.log(JSON.stringify(await upgradeProductionEvents(mongoose.connection.db, { apply: args.includes("--apply") }), null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  // Surface our field-level diagnostics, but never driver errors containing a URI.
  const detail = /^(?:Event [a-f\d]{24}(?::| changed during migration\.)|Event upgrade requires migration 006|Stop database writers and pass --writers-stopped|Use either --dry-run)/i.test(error.message)
    ? error.message : "Check the target database configuration and command arguments; no credentials or attendee data were printed.";
  console.error(`Event upgrade failed. ${detail}`);
  process.exitCode = 1;
});
