import dotenv from "dotenv";
import mongoose from "mongoose";
import Event from "../models/Event.js";
import { uniqueEventSlug } from "../services/public-content/event-slug.js";

dotenv.config();

const applying = process.argv.includes("--apply");
const productionConfirmed = process.argv.includes("--production-confirm=EVENT_SLUG_BACKFILL");
if (!applying) {
  console.error("Dry safety stop. Run with --apply after reviewing the target database.");
  process.exitCode = 1;
} else if (process.env.APP_ENV === "prod" && !productionConfirmed) {
  console.error("Production safety stop. Add --production-confirm=EVENT_SLUG_BACKFILL.");
  process.exitCode = 1;
} else if (!process.env.DB_USER || !process.env.DB_PASS || !process.env.DB) {
  console.error("Database configuration is incomplete.");
  process.exitCode = 1;
} else {
  const uri = `mongodb+srv://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASS)}@${process.env.DB}`;
  try {
    await mongoose.connect(uri);
    await Event.init();
    const events = await Event.find({ $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }] })
      .sort({ createdAt: 1, _id: 1 });
    let updated = 0;
    for (const event of events) {
      const slug = await uniqueEventSlug(Event, event.title, { excludeId: event._id });
      await Event.updateOne({ _id: event._id, $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }] }, { $set: { slug } });
      updated += 1;
    }
    console.log(`Assigned immutable SEO slugs to ${updated} existing events.`);
  } catch {
    console.error("Event slug backfill failed. No credentials or event data were printed.");
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
