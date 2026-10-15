import { calculateEventAverages, statisticsRegion } from "../services/background-services/regional-averages.js";
import { academicYearLabel } from "../util/config/academic-year.js";

export default {
  id: "021-member-ticket-share",
  async up(db) {
    const events = await db.collection("events").find({ status: "archived", cancellationRequestedAt: null }, {
      projection: { region: 1, status: 1, date: 1, correctedDate: 1, guestList: 1 },
    }).toArray();
    const byYear = new Map();
    for (const event of events) {
      const date = [event.correctedDate, event.date]
        .map(value => value ? new Date(value) : null)
        .find(value => value && Number.isFinite(value.getTime()));
      if (!date) continue;
      const year = academicYearLabel(date);
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(event);
    }

    const statistics = db.collection("statistics");
    const documents = await statistics.find({ type: "event-averages" }, {
      projection: { _id: 1, academicYear: 1, region: 1 },
    }).toArray();
    for (const document of documents) {
      const yearEvents = byYear.get(document.academicYear) || [];
      const scopedEvents = document.region === "national" ? yearEvents
        : yearEvents.filter(event => statisticsRegion(event.region) === document.region);
      await statistics.updateOne({ _id: document._id }, {
        $set: { "data.averageEventTicketTypeRatio": calculateEventAverages(scopedEvents).averageEventTicketTypeRatio,
          lastUpdated: new Date() },
      });
    }
  },
};
