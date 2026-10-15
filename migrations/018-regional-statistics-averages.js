import { calculateEventAverages, calculateMemberAverages, statisticsRegion, STATISTICS_REGIONS } from "../services/background-services/regional-averages.js";
import { academicYearLabel, academicYearRange } from "../util/config/academic-year.js";
import { CURRENT_ACCOUNT_FILTER } from "../util/subscriptions/policy.js";

export async function backfillRegionalAverages(db) {
    const now = new Date();
    const { start } = academicYearRange(now);
    const currentYear = academicYearLabel(now);
    const statistics = db.collection("statistics");
    await statistics.createIndex({ type: 1, academicYear: 1, region: 1 }, {
      unique: true,
      background: true,
      partialFilterExpression: { type: { $in: ["event-averages", "member-averages"] } },
    });

    const events = await db.collection("events").find({
      status: "archived", cancellationRequestedAt: null,
    }, { projection: { region: 1, status: 1, date: 1, correctedDate: 1, createdAt: 1,
      isFree: 1, product: 1, guestList: 1 } }).toArray();
    const members = await db.collection("memberUsers").find(CURRENT_ACCOUNT_FILTER,
      { projection: { region: 1, status: 1, joinDate: 1, purchaseDate: 1, expireDate: 1 } }).toArray();
    const regions = [...STATISTICS_REGIONS, "national"];
    const eventsByYear = new Map([[currentYear, []]]);
    for (const event of events) {
      const date = [event.correctedDate, event.date]
        .map(value => value ? new Date(value) : null)
        .find(value => value && Number.isFinite(value.getTime()));
      if (!date) continue;
      const year = academicYearLabel(date);
      if (!eventsByYear.has(year)) eventsByYear.set(year, []);
      eventsByYear.get(year).push(event);
    }
    for (const region of regions) {
      const scopedMembers = region === "national" ? members : members.filter(member => statisticsRegion(member.region) === region);
      for (const [academicYear, yearEvents] of eventsByYear) {
        const scopedEvents = region === "national" ? yearEvents : yearEvents.filter(event => statisticsRegion(event.region) === region);
        await statistics.updateOne({ type: "event-averages", academicYear, region }, {
          $set: { calculationType: "on-demand", data: calculateEventAverages(scopedEvents), lastUpdated: now },
        }, { upsert: true });
      }
      await statistics.updateOne({ type: "member-averages", academicYear: currentYear, region }, {
        $set: { calculationType: "weekly", data: calculateMemberAverages(scopedMembers, start, now, now), lastUpdated: now },
      }, { upsert: true });
    }
}

export default {
  id: "018-regional-statistics-averages",
  up: backfillRegionalAverages,
};
