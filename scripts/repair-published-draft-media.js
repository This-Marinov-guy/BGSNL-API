import dotenv from "dotenv";
import mongoose from "mongoose";
import Event from "../models/Event.js";
import { copyDraftEventMedia, publishedEventFolder } from "../services/events/promote-draft-media.js";

dotenv.config();

const apply = process.argv.includes("--apply");
const environment = process.env.APP_ENV;
if (!["dev", "prod"].includes(environment)) {
  console.error("Set APP_ENV=dev or APP_ENV=prod before inspecting event media.");
  process.exitCode = 1;
} else if (environment === "prod" && apply &&
  !process.argv.includes("--production-confirm=EVENT_MEDIA_REPAIR")) {
  console.error("Production safety stop. Add --production-confirm=EVENT_MEDIA_REPAIR.");
  process.exitCode = 1;
} else if (!process.env.DB_USER || !process.env.DB_PASS || !process.env.DB) {
  console.error("Database configuration is incomplete.");
  process.exitCode = 1;
} else {
  const uri = `mongodb+srv://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASS)}@${process.env.DB}`;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    const oldFolder = environment === "prod" ? "drafts/" : "development/drafts/";
    const candidates = await Event.find({ folder: { $regex: `^${oldFolder}` } })
      .select("_id folder poster ticketImg images").lean();
    let repaired = 0;
    let failed = 0;
    for (const event of candidates) {
      const id = String(event._id);
      if (event.folder !== `${oldFolder}${id}`) {
        console.log(`Skipping event ${id}: its draft folder is not owned by this event.`);
        continue;
      }
      if (!apply) {
        console.log(`Would repair event ${id}: ${event.folder} -> ${publishedEventFolder(id)}`);
        continue;
      }
      try {
        const folder = publishedEventFolder(id);
        const media = await copyDraftEventMedia(event, event, folder);
        const result = await Event.updateOne({
          _id: event._id,
          folder: event.folder,
          poster: event.poster,
          ticketImg: event.ticketImg,
          images: event.images,
        }, { $set: { ...media, folder } });
        if (result.modifiedCount !== 1) throw new Error("Event changed while media was being copied");
        repaired++;
        console.log(`Repaired event ${id}.`);
      } catch (error) {
        failed++;
        console.error(`Could not repair event ${id}: ${error.message}`);
      }
    }
    console.log(JSON.stringify({ environment, candidates: candidates.length, repaired, failed, dryRun: !apply }));
    if (failed) process.exitCode = 1;
  } catch (error) {
    console.error(`Event media repair failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
