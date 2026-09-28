// Moves QR tokens out of the standalone "ticketqrs" collection and onto the
// guest-list entries they admit (Event.guestList.ticketToken), then drops the
// collection. A token identifies a purchase, not an attendee, so every guest
// sharing the purchase code receives the same value: one image still admits
// the whole group, exactly as ticketqrs behaved.
const SOURCE_COLLECTION = "ticketqrs";
const INDEX_NAME = "guestlist_ticket_token";

const collectionExists = async (db, name) =>
  (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;

export default {
  id: "011-ticket-tokens-into-guest-list",
  async up(db) {
    const events = db.collection("events");
    // Not unique: a group purchase repeats one token across its guests, and a
    // unique multikey index also rejects duplicates inside a single document.
    await events.createIndex({ "guestList.ticketToken": 1 }, { name: INDEX_NAME });

    if (!await collectionExists(db, SOURCE_COLLECTION)) {
      console.log(`[011-ticket-tokens-into-guest-list] "${SOURCE_COLLECTION}" does not exist; index only.`);
      return;
    }

    let moved = 0;
    let unmatched = 0;
    for (const ticket of await db.collection(SOURCE_COLLECTION).find({}).toArray()) {
      const code = Number(ticket.code);
      if (!Number.isFinite(code) || typeof ticket.token !== "string") { unmatched++; continue; }
      const result = await events.updateOne(
        { _id: ticket.eventId },
        { $set: { "guestList.$[entry].ticketToken": ticket.token } },
        { arrayFilters: [{ "entry.code": code }] },
      );
      if (result.modifiedCount) moved++; else unmatched++;
    }
    console.log(`[011-ticket-tokens-into-guest-list] Moved ${moved} token(s) onto guest-list entries; ${unmatched} had no matching guest.`);

    await db.collection(SOURCE_COLLECTION).drop();
  },
};
