export default {
  id: "008-ticket-qr-indexes",
  async up(db) {
    const tickets = db.collection("ticketqrs");
    await tickets.createIndex({ token: 1 }, { unique: true, name: "token_1" });
    await tickets.createIndex({ eventId: 1, code: 1 }, { unique: true, name: "eventId_1_code_1" });
  },
};
