const ROLE_RENAMES = Object.freeze({
  society_board_member: "national_board_member",
  board_member: "regional_board_member",
  committee_member: "regional_committee_member",
});
const LEGACY_ROLES = Object.keys(ROLE_RENAMES);
const ACCOUNT_COLLECTIONS = ["memberUsers", "alumniUsers"];

const collectionExists = async (db, name) =>
  (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;

const renameRolesPipeline = () => [{
  $set: {
    roles: {
      $reduce: {
        input: {
          $map: {
            input: "$roles",
            as: "role",
            in: {
              $switch: {
                branches: Object.entries(ROLE_RENAMES).map(([legacy, current]) => ({
                  case: { $eq: ["$$role", legacy] },
                  then: current,
                })),
                default: "$$role",
              },
            },
          },
        },
        initialValue: [],
        in: {
          $cond: [
            { $in: ["$$this", "$$value"] },
            "$$value",
            { $concatArrays: ["$$value", ["$$this"]] },
          ],
        },
      },
    },
  },
}];

export default {
  id: "004-rename-legacy-account-roles",
  async up(db) {
    let modified = 0;
    for (const name of ACCOUNT_COLLECTIONS) {
      if (!await collectionExists(db, name)) {
        console.log(`[004-rename-legacy-account-roles] "${name}" does not exist; skipping.`);
        continue;
      }
      const result = await db.collection(name).updateMany(
        { roles: { $type: "array", $in: LEGACY_ROLES } },
        renameRolesPipeline(),
      );
      modified += result.modifiedCount;
    }
    console.log(`[004-rename-legacy-account-roles] Updated ${modified} account role array(s).`);
  },
};
