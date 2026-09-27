import "dotenv/config";
import mongoose from "mongoose";
import Event from "../models/Event.js";
import { auditProductionEvents } from "../services/events/event-production-audit.js";

async function main() {
  if (process.argv.length > 2) throw new Error("This command is read-only and accepts no arguments.");
  // eslint-disable-next-line no-process-env
  const { DB_USER, DB_PASS, DB } = process.env;
  if (!DB_USER || !DB_PASS || !DB) throw new Error("Missing database configuration.");
  mongoose.set("strictQuery", true);
  try {
    await mongoose.connect(`mongodb+srv://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASS)}@${DB}`, {
      autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 15000, readPreference: "primary",
    });
    const audit = await auditProductionEvents(mongoose.connection.db, Event);
    console.log(JSON.stringify(audit, null, 2));
    if (audit.schemaValidation.afterNormalization.invalidEvents) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  const detail = /^Event [a-f\d]{24}:/i.test(error.message)
    ? error.message : "Check database configuration and command arguments; no credentials or event data were printed.";
  console.error(`Read-only event audit failed. ${detail}`);
  process.exitCode = 1;
});
