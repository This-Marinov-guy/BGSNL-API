const fields = ["campaigns", "mmmCampaign2025"];

export default {
  id: "009-remove-retired-account-campaign-fields",
  async up(db) {
    // Use raw collections: these fields are no longer in the Mongoose models.
    // The deployment runner snapshots touched collections before writing.
    const filter = { $or: fields.map(field => ({ [field]: { $exists: true } })) };
    const update = { $unset: Object.fromEntries(fields.map(field => [field, ""])) };
    for (const name of ["memberUsers", "alumniUsers"]) {
      const result = await db.collection(name).updateMany(filter, update);
      console.log(`[009-remove-retired-account-campaign-fields] Cleaned ${result.modifiedCount} ${name} document(s).`);
    }
  },
};
