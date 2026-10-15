export default {
  id: "019-statistics-calculation-type",
  async up(db) {
    const statistics = db.collection("statistics");
    await statistics.updateMany({ type: "member-averages", calculationType: { $exists: false } },
      { $set: { calculationType: "weekly" } });
    await statistics.updateMany({ calculationType: { $exists: false } },
      { $set: { calculationType: "on-demand" } });
  },
};
