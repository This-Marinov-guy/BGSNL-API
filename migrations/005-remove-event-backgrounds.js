import { activeEventUpgradeQuery } from "../services/events/event-upgrade-scope.js";

const BACKGROUND_FIELDS = ["bgImage", "bgImageExtra", "bgImageSelection"];
const BACKGROUND_PATHS = BACKGROUND_FIELDS.flatMap(field => [field, `draftData.${field}`]);

export default {
  id: "005-remove-event-backgrounds",
  async up(db) {
    const activeEvents = activeEventUpgradeQuery();
    const filter = { $or: BACKGROUND_PATHS.map(path => ({ [path]: { $exists: true } })) };
    const update = { $unset: Object.fromEntries(BACKGROUND_PATHS.map(path => [path, ""])) };
    for (const name of ["events", "eventDrafts"]) {
      const result = await db.collection(name).updateMany({ ...(name === "events" ? activeEvents : {}), ...filter }, update);
      console.log(`[005-remove-event-backgrounds] Cleaned ${result.modifiedCount} ${name} document(s).`);
    }
  },
};
