export default {
  id: "006-region-event-slugs",
  async up(db) {
    const events = db.collection("events");
    // Establish the replacement constraint before removing the global one.
    await events.createIndex({ region: 1, slug: 1 }, {
      name: "event_region_slug_unique",
      unique: true,
      partialFilterExpression: { slug: { $type: "string" } },
    });
    for (const index of await events.indexes()) {
      if (index.unique && Object.keys(index.key).length === 1 && index.key.slug === 1) {
        await events.dropIndex(index.name);
      }
    }
  },
};
