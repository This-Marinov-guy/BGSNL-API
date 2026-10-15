export default {
  id: "016-event-feedbacks-into-events",
  async up(db) {
    const name = "eventFeedbacks";
    if (!(await db.listCollections({ name }).toArray()).length) return;
    const source = db.collection(name);
    const events = db.collection("events");
    const expected = await source.countDocuments();
    let copied = 0;
    for await (const feedback of source.find({})) {
      if (!feedback._id || !feedback.eventId || !feedback.ticketId || !feedback.recipientHash) {
        throw new Error("Event feedback has a missing identity");
      }
      const event = await events.findOne({ _id: feedback.eventId }, { projection: { _id: 1, feedbacks: 1 } });
      if (!event) throw new Error("Event feedback has no parent event");
      const existing = (event.feedbacks || []).find(row => String(row._id) === String(feedback._id));
      if (existing) { copied++; continue; }
      const duplicate = (event.feedbacks || []).some(row => String(row.ticketId) === String(feedback.ticketId) ||
        row.recipientHash === feedback.recipientHash);
      if (duplicate) throw new Error("Event feedback identity conflicts with an embedded response");
      const result = await events.updateOne({ _id: feedback.eventId, "feedbacks._id": { $ne: feedback._id } },
        { $push: { feedbacks: feedback } });
      if (result.modifiedCount !== 1) throw new Error("Event feedback could not be copied");
      copied++;
    }
    if (copied !== expected || copied !== await source.countDocuments()) throw new Error("Event feedback changed during migration");
    for await (const feedback of source.find({}, { projection: { _id: 1, eventId: 1 } })) {
      if (!await events.findOne({ _id: feedback.eventId, "feedbacks._id": feedback._id }, { projection: { _id: 1 } })) {
        throw new Error("Embedded event feedback could not be verified");
      }
    }
    await source.drop();
  },
};
