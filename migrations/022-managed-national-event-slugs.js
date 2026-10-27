export default {
  id: "022-managed-national-event-slugs",
  async up(db) {
    // Historical partner registrations share this collection and have no slug.
    // The partial index enforces stable URLs for managed national events only.
    await db.collection("nonSocietyEvents").createIndex({ region: 1, slug: 1 }, {
      name: "event_region_slug_unique",
      unique: true,
      partialFilterExpression: { slug: { $type: "string" } },
    });
  },
};
