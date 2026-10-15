import { academicYearLabel } from "../util/config/academic-year.js";
import { REGIONS } from "../util/config/defines.js";

const normalize = value => typeof value === "string" ? value.trim().toLowerCase() : "";
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const guestTicket = ticket => !ticket.refunded && ticket.memberPriceApplied !== true &&
  (String(ticket.type || "").toLowerCase().includes("guest") || (!ticket.type && !ticket.userId));

export default {
  id: "014-backfill-guest-marketing-emails",
  async up(db) {
    const accounts = new Set();
    for (const collection of ["memberUsers", "alumniUsers"]) {
      for await (const row of db.collection(collection).find({}, { projection: { email: 1 } })) {
        const email = normalize(row.email);
        if (validEmail(email)) accounts.add(email);
      }
    }
    const groups = new Map();
    for await (const event of db.collection("events").find({ "guestList.0": { $exists: true } },
      { projection: { region: 1, date: 1, correctedDate: 1, guestList: 1 } })) {
      const date = new Date(event.correctedDate || event.date);
      if (!REGIONS.includes(event.region) || !Number.isFinite(date.getTime())) continue;
      const academicYear = academicYearLabel(date);
      for (const ticket of event.guestList || []) {
        const email = normalize(ticket.email);
        if (!guestTicket(ticket) || !validEmail(email) || accounts.has(email)) continue;
        const key = `${academicYear}:${event.region}:${email}`;
        const ticketAt = new Date(ticket.timestamp || date);
        const when = Number.isFinite(ticketAt.getTime()) ? ticketAt : date;
        let group = groups.get(key);
        if (!group) {
          group = { email, academicYear, region: event.region, eventIds: new Set(), firstTicketAt: when,
            lastTicketAt: when };
          groups.set(key, group);
        }
        group.eventIds.add(event._id);
        if (when < group.firstTicketAt) group.firstTicketAt = when;
        if (when > group.lastTicketAt) group.lastTicketAt = when;
      }
    }
    const collection = db.collection("guestMarketingEmails");
    for (const group of groups.values()) {
      const { email, academicYear, region, firstTicketAt, lastTicketAt } = group;
      await collection.updateOne({ email, academicYear, region }, {
        $setOnInsert: { email, academicYear, region, firstTicketAt, createdAt: new Date() },
        $max: { lastTicketAt },
        $addToSet: { eventIds: { $each: [...group.eventIds] } },
        $currentDate: { updatedAt: true },
      }, { upsert: true });
    }
    await collection.createIndex({ academicYear: 1, region: 1, email: 1 },
      { unique: true, name: "unique_year_region_email" });
    await collection.createIndex({ email: 1 }, { name: "guest_email_account_cleanup" });
  },
};
