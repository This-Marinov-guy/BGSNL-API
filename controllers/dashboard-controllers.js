import MemberUser from "../models/MemberUser.js";
import Event from "../models/Event.js";
import HttpError from "../models/Http-error.js";
import { DEFAULT_REGION, REGIONS, SUBSCRIPTIONS } from "../util/config/defines.js";
import moment from "moment-timezone";
import { regionFilter } from "../middleware/authorization.js";
import { academicYearStart } from "../util/config/academic-year.js";
import { calculateEventAverages, calculateEventTotals, calculateMemberAverages, memberMonthSnapshots } from "../services/background-services/regional-averages.js";
import { CURRENT_ACCOUNT_FILTER } from "../util/subscriptions/policy.js";

const dashboardRegionFilter = (req, kind, requestedRegion) => {
  const filter = regionFilter(req, kind, requestedRegion);
  if (filter.region === "breda_tilburg") {
    return { region: { $in: ["breda_tilburg", "breda", "bread"] } };
  }
  if (filter.region === "unassigned") {
    return { region: { $nin: [...REGIONS, DEFAULT_REGION, "breda", "bread"] } };
  }
  return filter;
};

/**
 * GET /api/dashboard/members
 * Returns all members. Admins see all cities, board/committee see only their city.
 */
export const getMembers = async (req, res, next) => {
  try {
    const query = dashboardRegionFilter(req, "member", req.query.region);

    const users = await MemberUser.find(query)
      .select(
        "name surname email roles region status joinDate purchaseDate expireDate subscription tickets image phone birth university otherUniversityName graduationDate course profession"
      )
      .lean();

    const now = new Date();

    // Build subscription amount lookup: period -> monthly rate
    const subscriptionMonthlyRate = {};
    for (const sub of SUBSCRIPTIONS) {
      // amount is in cents, period is in months
      subscriptionMonthlyRate[sub.period] = sub.amount / 100 / sub.period;
    }

    let mmr = 0;

    const members = users.map((user) => {
      const isPaid = user.status === "active" && user.expireDate > now;
      const hasSubscription = !!user.subscription?.id;

      // Estimate next billing from expireDate (approximate)
      let nextBilling = null;
      if (hasSubscription && isPaid) {
        nextBilling = user.expireDate;
      }

      // Calculate MMR contribution from active subscribers
      if (hasSubscription && isPaid && user.subscription?.period) {
        const monthlyRate = subscriptionMonthlyRate[user.subscription.period];
        if (monthlyRate) {
          mmr += monthlyRate;
        }
      }

      const monthlyRevenue = hasSubscription && isPaid && user.subscription?.period
        ? subscriptionMonthlyRate[user.subscription.period] || 0
        : 0;

      return {
        _id: user._id,
        name: user.name,
        surname: user.surname,
        email: user.email,
        role: user.roles[user.roles.length - 1],
        region: user.region,
        status: user.status,
        joinDate: user.joinDate,
        startDate: user.purchaseDate,
        expireDate: user.expireDate,
        ticketsCount: user.tickets?.length || 0,
        hasSubscription,
        monthlyRevenue: Math.round(monthlyRevenue * 100) / 100,
        nextBilling,
        isPaid,
        phone: user.phone,
        birth: user.birth,
        university: user.university,
        otherUniversityName: user.otherUniversityName,
        graduationDate: user.graduationDate,
        course: user.course,
        profession: user.profession,
        image: user.image,
      };
    });

    // Summary stats
    const totalCount = members.length;
    const totalUnpaid = members.filter((m) => !m.isPaid).length;
    const totalActive = totalCount - totalUnpaid;

    return res.status(200).json({
      members,
      summary: {
        totalCount,
        totalActive,
        totalUnpaid,
        mmr: Math.round(mmr * 100) / 100,
      },
    });
  } catch (err) {
    if (err instanceof HttpError) return next(err);
    console.error("Error fetching members:", err);
    return next(new HttpError("Failed to fetch members", 500));
  }
};

/**
 * GET /api/dashboard/events-analytics
 * Returns all events with analytics data. Admins see all cities, board/committee see only their city.
 */
export const getEventsAnalytics = async (req, res, next) => {
  const fromDate = req.query.from;
  const toDate = req.query.to;

  try {
    const query = { status: { $nin: ["draft", "cancelled", "canceled"] },
      cancellationRequestedAt: null,
      ...dashboardRegionFilter(req, "event", req.query.region) };

    if (fromDate || toDate) {
      const dateRange = {};
      if (fromDate) {
        const start = moment.tz(fromDate, "YYYY-MM-DD", true, "Europe/Amsterdam");
        if (!start.isValid()) throw new HttpError("Choose a valid start date", 422);
        dateRange.$gte = start.startOf("day").toDate();
      }
      if (toDate) {
        const end = moment.tz(toDate, "YYYY-MM-DD", true, "Europe/Amsterdam");
        if (!end.isValid()) throw new HttpError("Choose a valid end date", 422);
        dateRange.$lte = end.endOf("day").toDate();
      }
      if (dateRange.$gte && dateRange.$lte && dateRange.$gte > dateRange.$lte) {
        throw new HttpError("Start date must be before end date", 422);
      }
      query.$or = [
        { correctedDate: dateRange },
        { correctedDate: null, date: dateRange },
      ];
    }

    const events = await Event.find(query)
      .select(
        "title poster date correctedDate createdAt region location product isFree isMemberFree guestList ticketLimit status extraInputsForm addOns cancellationRequestedAt"
      )
      .sort({ date: -1 })
      .lean();

    const analytics = events.map((event) => {
      const guestList = event.guestList || [];
      const totals = calculateEventTotals([event]);
      const attended = guestList.filter((g) => g.status === 1).length;
      const totalGuests = guestList.length;
      const nonRefundedGuests = guestList.filter((guest) => !guest.refunded).length;

      // Calculate revenue from guest list
      let revenue = 0;
      if (!event.isFree) {
        for (const guest of guestList) {
          if (guest.refunded) continue;

          const type = guest.type;
          if (type === "guest" && event.product?.guest?.price) {
            revenue += event.product.guest.price;
          } else if (type === "member" && event.product?.member?.price) {
            revenue += event.product.member.price;
          } else if (
            type === "active member" &&
            event.product?.activeMember?.price
          ) {
            revenue += event.product.activeMember.price;
          }
          // Add add-on revenue
          if (guest.addOns?.length) {
            for (const addOn of guest.addOns) {
              revenue += addOn.price || 0;
            }
          }
        }
      }

      // Ticket cost display
      let ticketCost = "FREE";
      if (!event.isFree && event.product) {
        const parts = [];
        if (event.product.guest?.price)
          parts.push(`€${event.product.guest.price}`);
        if (event.product.member?.price)
          parts.push(`€${event.product.member.price}`);
        else if (event.isMemberFree) parts.push("FREE");
        if (event.product.activeMember?.price)
          parts.push(`€${event.product.activeMember.price}`);
        ticketCost = parts.join(" / ");
      }

      return {
        _id: event._id,
        title: event.title,
        poster: event.poster,
        date: event.correctedDate || event.date,
        region: event.region,
        location: event.location,
        ticketCost,
        totalTickets: totalGuests,
        totalGuests: nonRefundedGuests,
        ticketLimit: event.ticketLimit,
        attended,
        presence:
          totalGuests > 0
            ? Math.round((attended / totalGuests) * 100)
            : 0,
        revenue: Math.round(revenue * 100) / 100,
        netRevenue: totals.revenue,
        refunds: totals.refunds,
        ticketCount: totals.ticketCount,
        memberTickets: totals.memberTickets,
        guestTickets: totals.guestTickets,
        status: event.status,
        columns: {
          addOns: Boolean(event.addOns?.isEnabled && event.addOns.items?.length),
          preferences: Array.isArray(event.extraInputsForm) && event.extraInputsForm.length > 0,
        },
        guestList: guestList.map((g) => ({
          id: String(g._id),
          name: g.name,
          email: g.email,
          type: g.type,
          status: g.status,
          timestamp: g.timestamp,
          refunded: g.refunded,
          preferences: g.preferences || {},
          addOns: (g.addOns || []).map((addOn) => ({
            title: addOn.title,
            price: addOn.price,
          })),
        })),
      };
    });

    // Summary
    const totalRevenue = analytics.reduce((sum, e) => sum + e.revenue, 0);
    const totalPresence = analytics.reduce((sum, e) => sum + e.attended, 0);
    const totalTicketsSold = analytics.reduce(
      (sum, e) => sum + e.totalTickets,
      0
    );
    const totalGuests = analytics.reduce((sum, event) => sum + event.totalGuests, 0);

    return res.status(200).json({
      events: analytics,
      summary: {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalPresence,
        totalTicketsSold,
        totalGuests,
        totalEvents: analytics.length,
        averages: calculateEventAverages(events),
      },
    });
  } catch (err) {
    if (err instanceof HttpError) return next(err);
    console.error("Error fetching events analytics:", err);
    return next(new HttpError("Failed to fetch events analytics", 500));
  }
};

const statisticsRange = (query) => {
  const today = moment().tz("Europe/Amsterdam");
  const from = moment.tz(query.from || moment(academicYearStart()).tz("Europe/Amsterdam").format("YYYY-MM-DD"),
    "YYYY-MM-DD", true, "Europe/Amsterdam");
  const to = moment.tz(query.to || today.format("YYYY-MM-DD"), "YYYY-MM-DD", true, "Europe/Amsterdam");
  if (!from.isValid() || !to.isValid() || from.isAfter(to, "day")) {
    throw new HttpError("Choose a valid statistics date range", 422);
  }
  return { from: from.startOf("day"), to: to.endOf("day") };
};

/** Aggregate-only response for every dashboard role. Account identities stay on the management endpoint. */
export const getMemberStatistics = async (req, res, next) => {
  let range;
  try { range = statisticsRange(req.query); }
  catch (error) { return next(error); }
  const scopedResponse = {
    status(code) { res.status(code); return this; },
    async json(payload) {
      const monthly = {};
      let totalActive = 0;
      let totalInactive = 0;
      let mmr = 0;
      for (const member of payload.members || []) {
        if (CURRENT_ACCOUNT_FILTER.status.$nin.includes(member.status)) continue;
        if (member.isPaid) totalActive += 1;
        else totalInactive += 1;
        mmr += Number(member.monthlyRevenue) || 0;

        const joinedAt = member.joinDate || member.startDate;
        if (!joinedAt) continue;
        const joined = moment(joinedAt).tz("Europe/Amsterdam");
        if (!joined.isValid() || joined.isBefore(range.from) || joined.isAfter(range.to)) continue;
        const month = joined.format("YYYY-MM");
        monthly[month] = (monthly[month] || 0) + 1;
      }
      const region = regionFilter(req, "member", req.query.region).region || "national";
      const from = range.from.toDate();
      const to = range.to.toDate();
      const now = new Date();
      const averages = calculateMemberAverages(payload.members || [], from, to, now);
      const activeMonthly = Object.fromEntries(memberMonthSnapshots(payload.members || [], from, to, now)
        .map(({ month, active }) => [month, active]));
      // The benchmark contains aggregates only; identities remain on the scoped management endpoint.
      const nationalAverages = region === "national" ? averages : calculateMemberAverages(
        await MemberUser.find(CURRENT_ACCOUNT_FILTER)
          .select("status joinDate purchaseDate expireDate")
          .lean(), from, to, now,
      );
      return res.json({ region,
        summary: { totalActive, totalInactive, mmr: Math.round(mmr * 100) / 100 }, monthly, activeMonthly,
        averages, nationalAverages,
      });
    },
  };
  return getMembers(req, scopedResponse, next);
};

/** Aggregate-only response for every dashboard role. Ticket identities stay on the management endpoint. */
export const getEventStatistics = async (req, res, next) => {
  let range;
  try { range = statisticsRange(req.query); }
  catch (error) { return next(error); }
  let eventOptions;
  try {
    eventOptions = await Event.find({ status: { $nin: ["draft", "cancelled", "canceled"] },
      cancellationRequestedAt: null,
      ...dashboardRegionFilter(req, "event", req.query.region) })
      .select("_id title date correctedDate")
      .sort({ date: -1 })
      .lean();
  } catch (error) {
    return next(error instanceof HttpError ? error : new HttpError("Failed to fetch event statistics", 500));
  }
  const scopedRequest = { ...req, query: { ...req.query,
    from: range.from.format("YYYY-MM-DD"), to: range.to.format("YYYY-MM-DD") } };
  const scopedResponse = {
    status(code) { res.status(code); return this; },
    async json(payload) {
      const region = regionFilter(req, "event", req.query.region).region || "national";
      const averages = payload.summary?.averages;
      const nationalAverages = region === "national" ? averages : calculateEventAverages(
        await Event.find({ status: { $nin: ["draft", "cancelled", "canceled"] }, cancellationRequestedAt: null,
          $or: [
            { correctedDate: { $gte: range.from.toDate(), $lte: range.to.toDate() } },
            { correctedDate: null, date: { $gte: range.from.toDate(), $lte: range.to.toDate() } },
          ] })
          .select("status date correctedDate createdAt isFree product guestList cancellationRequestedAt")
          .lean(),
      );
      return res.json({ region,
        eventOptions: eventOptions.map((event) => ({
        _id: event._id, title: event.title, date: event.correctedDate || event.date,
      })), events: (payload.events || []).map((event) => ({
        _id: event._id, title: event.title, date: event.date, region: event.region,
        revenue: event.netRevenue, refunds: event.refunds, ticketCount: event.ticketCount,
        memberTickets: event.memberTickets, guestTickets: event.guestTickets,
        totalGuests: event.totalGuests, ticketLimit: event.ticketLimit,
      })), averages, nationalAverages });
    },
  };
  try { return await getEventsAnalytics(scopedRequest, scopedResponse, next); }
  catch (error) { return next(error instanceof HttpError ? error : new HttpError("Failed to fetch event statistics", 500)); }
};
