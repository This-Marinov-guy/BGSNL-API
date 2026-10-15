import { backfillRegionalAverages } from "./018-regional-statistics-averages.js";

const LEGACY_BREDA = ["breda", "bread"];

export default {
  id: "020-national-statistics-regions",
  async up(db) {
    for (const name of ["events", "memberUsers"]) {
      await db.collection(name).updateMany({ region: { $in: LEGACY_BREDA } },
        { $set: { region: "breda_tilburg" } });
    }
    await backfillRegionalAverages(db);
    await db.collection("statistics").deleteMany({
      type: { $in: ["event-averages", "member-averages"] },
      region: { $in: LEGACY_BREDA },
    });
  },
};
