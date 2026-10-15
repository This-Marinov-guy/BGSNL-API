import moment from "moment-timezone";
import Event from "../../models/Event.js";
import MemberUser from "../../models/MemberUser.js";
import Statistics from "../../models/Statistics.js";
import { DEFAULT_REGION, REGIONS } from "../../util/config/defines.js";
import { academicYearLabel, academicYearRange } from "../../util/config/academic-year.js";
import { CURRENT_ACCOUNT_FILTER } from "../../util/subscriptions/policy.js";

const ZONE = "Europe/Amsterdam";
const round = value => Math.round(value * 100) / 100;
const validDate = value => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
};
const eventDate = event => validDate(event.correctedDate) || validDate(event.date);
export const STATISTICS_REGIONS = Object.freeze([...REGIONS, DEFAULT_REGION, "unassigned"]);
export const statisticsRegion = value => {
  const normalized = ["breda", "bread"].includes(value) ? "breda_tilburg" : value;
  return STATISTICS_REGIONS.includes(normalized) ? normalized : "unassigned";
};

const ticketPrice = (event, ticket) => {
  const tier = ticket.type === "guest" ? "guest"
    : ticket.type === "active member" ? "activeMember" : "member";
  const base = tier === "activeMember"
    ? event.product?.activeMember?.price ?? event.product?.member?.price
    : event.product?.[tier]?.price;
  return (event.isFree ? 0 : Math.max(0, Number(base) || 0)) +
    (ticket.addOns || []).reduce((total, addOn) => total + Math.max(0, Number(addOn.price) || 0), 0);
};

const eventTotals = (events = []) => {
  let ticketCount = 0, memberTickets = 0, guestTickets = 0;
  let presenceHours = 0, presenceSamples = 0, revenue = 0, refunds = 0;
  const held = events.filter(event => event.status !== "cancelled" &&
    event.status !== "canceled" && !event.cancellationRequestedAt);
  for (const event of held) {
    const date = eventDate(event);
    const created = validDate(event.createdAt);
    if (date && created && date >= created) {
      presenceHours += (date - created) / 3_600_000;
      presenceSamples++;
    }
    for (const ticket of event.guestList || []) {
      ticketCount++;
      if (ticket.type === "guest") guestTickets++;
      else if (["member", "active member", "alumni"].includes(ticket.type)) memberTickets++;
      const gross = ticketPrice(event, ticket);
      const recordedRefund = ticket.refundAmountCents == null ? NaN : Number(ticket.refundAmountCents);
      const refunded = Number.isFinite(recordedRefund) && recordedRefund >= 0
        ? recordedRefund / 100 : ticket.refunded ? gross : 0;
      refunds += refunded;
      revenue += gross - refunded;
    }
  }
  return { eventCount: held.length, ticketCount, memberTickets, guestTickets,
    presenceHours, presenceSamples, revenue, refunds };
};

/** Issued tickets and estimated net amounts, including recorded partial refunds. */
export function calculateEventTotals(events = []) {
  const totals = eventTotals(events);
  return { eventCount: totals.eventCount, ticketCount: totals.ticketCount,
    memberTickets: totals.memberTickets, guestTickets: totals.guestTickets,
    revenue: round(totals.revenue), refunds: round(totals.refunds) };
}

/** Averages are per supplied event. Member share pools issued tickets across events. */
export function calculateEventAverages(events = []) {
  const { eventCount: count, ticketCount, memberTickets, guestTickets,
    presenceHours, presenceSamples, revenue, refunds } = eventTotals(events);
  return {
    eventCount: count,
    averageEventPresence: presenceSamples ? round(presenceHours / presenceSamples) : null,
    averageEventTicketCount: count ? round(ticketCount / count) : null,
    averageEventTicketTypeRatio: ticketCount ? round(memberTickets / ticketCount * 100) : null,
    memberTickets,
    guestTickets,
    averageEventRevenue: count ? round(revenue / count) : null,
    averageEventRefund: count ? round(refunds / count) : null,
  };
}

/** Active totals and new joins at each month end, capped at the selected end or today. */
export function memberMonthSnapshots(members = [], from, to, now = new Date()) {
  const start = moment(from).tz(ZONE);
  const end = moment(to).tz(ZONE);
  const current = moment(now).tz(ZONE);
  if (!start.isValid() || !end.isValid() || start.isAfter(end)) {
    return [];
  }
  const snapshots = [];
  for (let month = start.clone().startOf("month"); month.isSameOrBefore(end, "month"); month.add(1, "month")) {
    const beginning = moment.max(month.clone(), start);
    const ending = moment.min(month.clone().endOf("month"), end, current);
    if (beginning.isAfter(ending)) break;
    let active = 0, newMembers = 0;
    for (const member of members) {
      if (CURRENT_ACCOUNT_FILTER.status.$nin.includes(member.status)) continue;
      const joined = validDate(member.joinDate || member.purchaseDate);
      if (joined && joined >= beginning.toDate() && joined <= ending.toDate()) newMembers++;
      if (member.status === "active" && joined && joined <= ending.toDate() &&
        validDate(member.expireDate) > ending.toDate()) active++;
    }
    snapshots.push({ month: month.format("YYYY-MM"), active, newMembers });
  }
  return snapshots;
}

/** Month-end active counts and new joins, averaged over touched calendar months. */
export function calculateMemberAverages(members = [], from, to, now = new Date()) {
  const snapshots = memberMonthSnapshots(members, from, to, now);
  const monthCount = snapshots.length;
  const activeTotal = snapshots.reduce((total, month) => total + month.active, 0);
  const newTotal = snapshots.reduce((total, month) => total + month.newMembers, 0);
  return {
    monthCount,
    averageActiveMembersMonth: monthCount ? round(activeTotal / monthCount) : null,
    averageNewMembersMonth: monthCount ? round(newTotal / monthCount) : null,
  };
}

const dateQuery = (start, end) => ({ $or: [
  { correctedDate: { $gte: start, $lt: end } },
  { correctedDate: null, date: { $gte: start, $lt: end } },
] });

async function saveAverages({ type, calculationType, year, items, calculate, StatisticsModel,
  insertOnly = false, at = new Date() }) {
  const regions = STATISTICS_REGIONS;
  await Promise.all([...regions, "national"].map(region => StatisticsModel.updateOne(
    { type, academicYear: year, region },
    { [insertOnly ? "$setOnInsert" : "$set"]: { calculationType,
      data: calculate(region === "national" ? items : items.filter(item => statisticsRegion(item.region) === region)), lastUpdated: at } },
    { upsert: true },
  )));
}

/** Seed a new academic year without changing any records already written for it. */
export async function initializeAcademicYearStatistics(now = new Date(), {
  EventModel = Event, MemberModel = MemberUser, StatisticsModel = Statistics,
} = {}) {
  const { start, end } = academicYearRange(now);
  const year = academicYearLabel(now);
  const [events, members] = await Promise.all([
    EventModel.find({ status: "archived", cancellationRequestedAt: null,
      ...dateQuery(start, now < end ? now : end) }).select("region status date correctedDate createdAt isFree product guestList").lean(),
    MemberModel.find(CURRENT_ACCOUNT_FILTER)
      .select("region status joinDate purchaseDate expireDate").lean(),
  ]);
  await Promise.all([
    saveAverages({ type: "event-averages", calculationType: "on-demand", year, items: events,
      calculate: calculateEventAverages, StatisticsModel, insertOnly: true, at: now }),
    saveAverages({ type: "member-averages", calculationType: "weekly", year, items: members,
      calculate: scoped => calculateMemberAverages(scoped, start, now, now),
      StatisticsModel, insertOnly: true, at: now }),
  ]);
  return year;
}

export async function refreshEventAverages(event, { EventModel = Event, StatisticsModel = Statistics } = {}) {
  const date = eventDate(event);
  if (!date) return;
  const { start, end } = academicYearRange(date);
  const events = await EventModel.find({ status: "archived", cancellationRequestedAt: null,
    ...dateQuery(start, end) }).select("region status date correctedDate createdAt isFree product guestList").lean();
  await saveAverages({ type: "event-averages", calculationType: "on-demand", year: academicYearLabel(date), items: events,
    calculate: calculateEventAverages, StatisticsModel });
}

export async function refreshMemberAverages(now = new Date(), {
  MemberModel = MemberUser, StatisticsModel = Statistics,
} = {}) {
  const { start } = academicYearRange(now);
  const members = await MemberModel.find(CURRENT_ACCOUNT_FILTER)
    .select("region status joinDate purchaseDate expireDate").lean();
  await saveAverages({ type: "member-averages", calculationType: "weekly", year: academicYearLabel(now), items: members,
    calculate: scoped => calculateMemberAverages(scoped, start, now, now), StatisticsModel });
}
