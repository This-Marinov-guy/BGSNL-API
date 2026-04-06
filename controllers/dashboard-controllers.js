import User from "../models/User.js";
import Event from "../models/Event.js";
import HttpError from "../models/Http-error.js";
import { extractUserFromRequest } from "../util/functions/security.js";
import { ACCESS_2, SUBSCRIPTIONS } from "../util/config/defines.js";
import moment from "moment-timezone";

/**
 * GET /api/dashboard/members
 * Returns all members. Admins see all cities, board/committee see only their city.
 */
export const getMembers = async (req, res, next) => {
  const { roles, region } = extractUserFromRequest(req);
  const isAdmin = roles.some((r) => ACCESS_2.includes(r));

  const filterRegion = req.query.region;

  try {
    const query = {};

    if (!isAdmin) {
      // Board/committee can only see their city
      query.region = region;
    } else if (filterRegion) {
      query.region = filterRegion;
    }

    const users = await User.find(query)
      .select(
        "name surname email roles region status purchaseDate expireDate subscription tickets image phone university"
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
      const isPaid = user.expireDate > now;
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

      return {
        _id: user._id,
        name: user.name,
        surname: user.surname,
        email: user.email,
        role: user.roles[user.roles.length - 1],
        region: user.region,
        status: user.status,
        startDate: user.purchaseDate,
        expireDate: user.expireDate,
        ticketsCount: user.tickets?.length || 0,
        hasSubscription,
        nextBilling,
        isPaid,
        phone: user.phone,
        university: user.university,
        image: user.image,
      };
    });

    // Summary stats
    const totalCount = members.length;
    const totalUnpaid = members.filter((m) => !m.isPaid).length;

    res.status(200).json({
      members,
      summary: {
        totalCount,
        totalUnpaid,
        mmr: Math.round(mmr * 100) / 100,
      },
    });
  } catch (err) {
    console.error("Error fetching members:", err);
    return next(new HttpError("Failed to fetch members", 500));
  }
};

/**
 * GET /api/dashboard/events-analytics
 * Returns all events with analytics data. Admins see all cities, board/committee see only their city.
 */
export const getEventsAnalytics = async (req, res, next) => {
  const { roles, region } = extractUserFromRequest(req);
  const isAdmin = roles.some((r) => ACCESS_2.includes(r));

  const filterRegion = req.query.region;
  const fromDate = req.query.from;
  const toDate = req.query.to;

  try {
    const query = { status: { $ne: "archived" } };

    if (!isAdmin) {
      query.region = region;
    } else if (filterRegion) {
      query.region = filterRegion;
    }

    if (fromDate || toDate) {
      query.date = {};
      if (fromDate) {
        query.date.$gte = moment(fromDate, "YYYY-MM-DD")
          .startOf("day")
          .toDate();
      }
      if (toDate) {
        query.date.$lte = moment(toDate, "YYYY-MM-DD").endOf("day").toDate();
      }
    }

    const events = await Event.find(query)
      .select(
        "title poster date region location product isFree isMemberFree guestList ticketLimit status"
      )
      .sort({ date: -1 })
      .lean();

    const analytics = events.map((event) => {
      const guestList = event.guestList || [];
      const attended = guestList.filter((g) => g.status === 1).length;
      const totalGuests = guestList.length;

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
        date: event.date,
        region: event.region,
        location: event.location,
        ticketCost,
        totalTickets: totalGuests,
        ticketLimit: event.ticketLimit,
        attended,
        presence:
          totalGuests > 0
            ? Math.round((attended / totalGuests) * 100)
            : 0,
        revenue: Math.round(revenue * 100) / 100,
        status: event.status,
        guestList: guestList.map((g) => ({
          name: g.name,
          email: g.email,
          type: g.type,
          status: g.status,
          timestamp: g.timestamp,
          refunded: g.refunded,
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

    res.status(200).json({
      events: analytics,
      summary: {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalPresence,
        totalTicketsSold,
        totalEvents: analytics.length,
      },
    });
  } catch (err) {
    console.error("Error fetching events analytics:", err);
    return next(new HttpError("Failed to fetch events analytics", 500));
  }
};
