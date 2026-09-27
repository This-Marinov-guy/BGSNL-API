// Renames the "users" collection to "memberUsers", matching the MemberUser
// model (models/MemberUser.js) that replaced models/User.js. Already applied
// by hand on the dev database (scripts/rename-users-collection.js); this is
// the same operation, wired to run automatically on the next production
// deploy so the new code finds its data under the name it now expects.
const SOURCE_COLLECTION = "users";
const TARGET_COLLECTION = "memberUsers";

const collectionExists = async (db, name) =>
  (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;

export default {
  id: "001-rename-users-to-member-users",
  async up(db) {
    const sourceExists = await collectionExists(db, SOURCE_COLLECTION);
    const targetExists = await collectionExists(db, TARGET_COLLECTION);

    if (!sourceExists) {
      if (targetExists) {
        console.log(
          `[001-rename-users-to-member-users] "${SOURCE_COLLECTION}" is already gone and "${TARGET_COLLECTION}" exists; nothing to do.`
        );
        return;
      }
      throw new Error(
        `Neither "${SOURCE_COLLECTION}" nor "${TARGET_COLLECTION}" exists. Refusing to guess.`
      );
    }

    if (targetExists) {
      const targetCount = await db.collection(TARGET_COLLECTION).countDocuments();
      if (targetCount > 0) {
        throw new Error(
          `"${TARGET_COLLECTION}" already exists with ${targetCount} document(s). Refusing to overwrite it.`
        );
      }
      // Mongoose auto-creates an empty placeholder collection (with its
      // indexes) the moment the app's model registers under the new name.
      await db.collection(TARGET_COLLECTION).drop();
    }

    const sourceCount = await db.collection(SOURCE_COLLECTION).countDocuments();
    await db.collection(SOURCE_COLLECTION).rename(TARGET_COLLECTION);

    const renamedCount = await db.collection(TARGET_COLLECTION).countDocuments();
    if (renamedCount !== sourceCount) {
      throw new Error(
        `Post-rename count mismatch: expected ${sourceCount}, got ${renamedCount}.`
      );
    }
  },
};
