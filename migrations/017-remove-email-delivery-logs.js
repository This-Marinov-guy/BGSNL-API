const obsoleteCollections = [
  "eventEmailDeliveries", "eventcancellationdeliveries", "eventFeedbackDeliveries",
  "monthlySummaryDeliveries", "monthlySummaries",
];

const exists = async (db, name) => Boolean((await db.listCollections({ name }).toArray()).length);

export default {
  id: "017-remove-email-delivery-logs",
  async up(db) {
    // Dev previously embedded delivery records in 015. Production will skip
    // that copy, but both databases need the same final shape.
    await db.collection("events").updateMany({}, { $unset: {
      emailDeliveries: 1, cancellationDeliveries: 1, feedbackDeliveries: 1,
      feedbackEmailSeededAt: 1, feedbackEmailFailedCount: 1,
    } });
    const eventIndexes = new Set((await db.collection("events").indexes()).map(index => index.name));
    for (const name of ["emailDeliveries._id_1", "emailDeliveries.campaignId_1_emailDeliveries.status_1",
      "feedbackDeliveries.status_1_feedbackDeliveries.nextAttemptAt_1"]) {
      if (eventIndexes.has(name)) await db.collection("events").dropIndex(name);
    }
    for (const name of obsoleteCollections) if (await exists(db, name)) await db.collection(name).drop();
    if (!await exists(db, "monitoringjobs")) await db.createCollection("monitoringjobs");
    await db.collection("monitoringjobs").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection("monitoringjobs").createIndex({ status: 1, activityAt: -1 });
  },
};
