// Older scheduled cleanups were stored for 15 August at 03:00 Amsterdam.
// Move only those exact annual cutoff timestamps to 25 August; retry dates
// and manually changed dates keep their meaning.
const movedCutoff = value => {
  const date = new Date(value);
  if (date.getUTCMonth() !== 7 || date.getUTCDate() !== 15 || date.getUTCHours() !== 1 ||
    date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) return null;
  date.setUTCDate(25);
  return date;
};

export default {
  id: "013-august-25-media-reset",
  async up(db) {
    for (const [collectionName, field] of [["events", "mediaCleanupDueAt"], ["eventMediaCleanups", "dueAt"]]) {
      const collection = db.collection(collectionName);
      for await (const row of collection.find({ [field]: { $type: "date" } }, { projection: { [field]: 1 } })) {
        const date = movedCutoff(row[field]);
        if (date) await collection.updateOne({ _id: row._id, [field]: row[field] }, { $set: { [field]: date } });
      }
    }
  },
};
