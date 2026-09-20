// Consolidate the former Breda region slug under the current Breda–Tilburg
// region. "bread" is included as an old typo found in legacy data.
const LEGACY_REGIONS = ["breda", "bread"];
const TARGET_REGION = "breda_tilburg";
const REGION_PATHS = ["region", "draftData.region", "draftOwner.region"];

const applicationCollections = async (db) => {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  return collections
    .map(({ name }) => name)
    .filter((name) => name && name !== "_migrations" && !name.startsWith("system."));
};

export default {
  id: "003-normalize-breda-region",
  async up(db) {
    let modified = 0;
    for (const name of await applicationCollections(db)) {
      const collection = db.collection(name);
      for (const path of REGION_PATHS) {
        const result = await collection.updateMany(
          { [path]: { $in: LEGACY_REGIONS } },
          { $set: { [path]: TARGET_REGION } },
        );
        modified += result.modifiedCount;
      }
    }
    console.log(`[003-normalize-breda-region] Updated ${modified} region value(s) to ${TARGET_REGION}.`);
  },
};
