export default {
  id: "010-simplify-support-statuses",
  async up(db) {
    const collection = db.collection("supportConversations");
    await collection.updateMany({ status: { $in: ["in_progress", "waiting_for_you"] } }, { $set: { status: "open" } });
    await collection.updateMany({ status: "closed" }, { $set: { status: "resolved" } });
  },
};
