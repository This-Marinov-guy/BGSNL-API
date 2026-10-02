// Seed once; database edits remain authoritative on every later migration run.
export const initialRegionEmails = Object.freeze({
  netherlands: "info@bulgariansociety.nl",
  support: "bgsn.tech.nl@gmail.com",
  groningen: "bulgariansociety.gro@gmail.com",
  rotterdam: "bulgariansociety.rtm@gmail.com",
  leeuwarden: "bulgariansociety.lwd@gmail.com",
  breda_tilburg: "bulgariansociety.bre@gmail.com",
  amsterdam: "bulgariansociety.ams@gmail.com",
  maastricht: "bulgariansociety.maas@gmail.com",
  eindhoven: "bulgariansociety.eind@gmail.com",
  leiden_hague: "bulgariansociety.leiden.hague@gmail.com",
});

export default {
  id: "012-region-contacts",
  async up(db) {
    const now = new Date();
    for (const [_id, email] of Object.entries(initialRegionEmails)) {
      await db.collection("regionContacts").updateOne({ _id }, {
        $setOnInsert: { email, createdAt: now, updatedAt: now },
      }, { upsert: true });
    }
  },
};
