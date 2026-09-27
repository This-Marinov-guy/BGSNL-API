// Renames every remaining collection to match its model's camelCase name.
// (users -> memberUsers is handled by migration 001; "contests", "documents",
// "events", "internships" and "statistics" are single words and need no
// change.)
const RENAMES = [
  ["activemembers", "activeMembers"],
  ["alumniusers", "alumniUsers"],
  ["internshipapplications", "internshipApplications"],
  ["nonsocietyevents", "nonSocietyEvents"],
  ["supportconversations", "supportConversations"],
  ["temporarycodes", "temporaryCodes"],
];

const collectionExists = async (db, name) =>
  (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;

const renameCollection = async (db, source, target) => {
  const sourceExists = await collectionExists(db, source);
  const targetExists = await collectionExists(db, target);

  if (!sourceExists) {
    if (targetExists) {
      console.log(`[002-camelcase-collection-names] "${source}" is already gone and "${target}" exists; nothing to do.`);
      return;
    }
    // Neither exists (e.g. an unused collection, like "supportconversations"
    // with zero documents that was never created). Nothing to rename.
    console.log(`[002-camelcase-collection-names] Neither "${source}" nor "${target}" exists; skipping.`);
    return;
  }

  if (targetExists) {
    const targetCount = await db.collection(target).countDocuments();
    if (targetCount > 0) {
      throw new Error(`"${target}" already exists with ${targetCount} document(s). Refusing to overwrite it.`);
    }
    // Mongoose auto-creates an empty placeholder collection (with its
    // indexes) the moment the app's model registers under the new name.
    await db.collection(target).drop();
  }

  const sourceCount = await db.collection(source).countDocuments();
  await db.collection(source).rename(target);

  const renamedCount = await db.collection(target).countDocuments();
  if (renamedCount !== sourceCount) {
    throw new Error(`Post-rename count mismatch for ${target}: expected ${sourceCount}, got ${renamedCount}.`);
  }
  console.log(`[002-camelcase-collection-names] Renamed "${source}" to "${target}" (${renamedCount} document(s)).`);
};

export default {
  id: "002-camelcase-collection-names",
  async up(db) {
    for (const [source, target] of RENAMES) {
      await renameCollection(db, source, target);
    }
  },
};
