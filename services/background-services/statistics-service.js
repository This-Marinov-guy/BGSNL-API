import MemberUser from "../../models/MemberUser.js";
import AlumniUser from "../../models/AlumniUser.js";
import Statistics from "../../models/Statistics.js";
import HttpError from "../../models/Http-error.js";
import moment from "moment";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { runObservedJob } from "../monitoring/job-history.js";

const SUPPORTED_DATE_INPUT_FORMATS = [
  moment.ISO_8601,
  "DD-MM-YYYY",
  "D-M-YYYY",
  "DD/MM/YYYY",
  "D/M/YYYY",
  "YYYY-MM-DD",
];

const parseDateBoundary = (value, boundary, label) => {
  if (value instanceof Date) {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new HttpError(`Invalid ${label}`, 400);
    }

    if (boundary === "start") {
      parsed.setHours(0, 0, 0, 0);
    } else {
      parsed.setHours(23, 59, 59, 999);
    }

    return parsed;
  }

  const parsed = moment(value, SUPPORTED_DATE_INPUT_FORMATS, true);

  if (!parsed.isValid()) {
    throw new HttpError(
      `Invalid ${label}. Supported formats: DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, or ISO 8601`,
      400
    );
  }

  return boundary === "start"
    ? parsed.startOf("day").toDate()
    : parsed.endOf("day").toDate();
};

/**
 * Internal function to recount and update member statistics
 */
const _recountMemberStatistics = async () => {
  try {
    const today = new Date();
    const memberCount = await MemberUser.countDocuments({
      expireDate: { $gt: today },
      status: "active",
    });

    let memberStatistics = await Statistics.findOne({ type: "member" });

    if (!memberStatistics) {
      memberStatistics = await Statistics.create({
        type: "member",
        data: {
          total: 0,
        },
      });
    }

    memberStatistics.data = memberStatistics.data || {};
    memberStatistics.data.total = memberCount;
    memberStatistics.lastUpdated = new Date();
    memberStatistics.markModified("data");

    await memberStatistics.save();
    console.log(`Member statistics updated: ${memberCount} active members`);
    return { success: true, count: memberCount };
  } catch (err) {
    logOperationalError("service.member-statistics", err);
    console.error("Error recounting member statistics:", err);
    return { success: false, error: err.message };
  }
};

/**
 * Internal function to recount and update alumni statistics
 */
const _recountAlumniStatistics = async () => {
  try {
    const alumniCount = await AlumniUser.countDocuments({ status: "active" });

    let alumniStatistics = await Statistics.findOne({ type: "alumni" });

    if (!alumniStatistics) {
      alumniStatistics = await Statistics.create({
        type: "alumni",
        data: {
          total: 0,
        },
      });
    }

    alumniStatistics.data = alumniStatistics.data || {};
    alumniStatistics.data.total = alumniCount;
    alumniStatistics.lastUpdated = new Date();
    alumniStatistics.markModified("data");

    await alumniStatistics.save();
    console.log(`Alumni statistics updated: ${alumniCount} alumni`);
    return { success: true, count: alumniCount };
  } catch (err) {
    logOperationalError("service.alumni-statistics", err);
    console.error("Error recounting alumni statistics:", err);
    return { success: false, error: err.message };
  }
};

/**
 * Recount and update member statistics as a background job (non-blocking)
 */
export const recountMemberStatistics = () => {
  setImmediate(async () => {
    try {
      await runObservedJob("scheduler", "member-statistics", _recountMemberStatistics);
    } catch (err) {
      logOperationalError("worker.member-statistics", err);
      console.error("Background job error in recountMemberStatistics:", err);
    }
  });
};

/**
 * Recount and update alumni statistics as a background job (non-blocking)
 */
export const recountAlumniStatistics = () => {
  setImmediate(async () => {
    try {
      await runObservedJob("scheduler", "alumni-statistics", _recountAlumniStatistics);
    } catch (err) {
      logOperationalError("worker.alumni-statistics", err);
      console.error("Background job error in recountAlumniStatistics:", err);
    }
  });
};

/**
 * Returns all users created within a date range, grouped by region, with alumni as a separate entry.
 *
 * @param {string|Date} startDate - Start of the range (inclusive)
 * @param {string|Date|null} endDate - End of the range (inclusive); defaults to today (end of day)
 * @returns {{
 *   startDate: Date,
 *   endDate: Date,
 *   byRegion: Record<string, { count: number, users: object[] }>,
 *   alumni: { count: number, users: object[] },
 *   totals: { members: number, alumni: number, all: number }
 * }}
 */
export const getUsersByDateRange = async (startDate, endDate = null) => {
  const start = parseDateBoundary(startDate, "start", "startDate");
  const end = endDate
    ? parseDateBoundary(endDate, "end", "endDate")
    : parseDateBoundary(new Date(), "end", "endDate");

  console.log(`[getUsersByDateRange] Querying | from=${start.toISOString()} | to=${end.toISOString()}`);

  const dateFilter = { joinDate: { $gte: start, $lte: end } };

  let regionGroups, alumniUsers;
  try {
    [regionGroups, alumniUsers] = await Promise.all([
      MemberUser.aggregate([
        { $match: dateFilter },
        {
          $group: {
            _id: "$region",
            count: { $sum: 1 },
            users: {
              $push: {
                _id: "$_id",
                name: "$name",
                surname: "$surname",
                email: "$email",
                joinDate: "$joinDate",
              },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      AlumniUser.find(dateFilter)
        .select("_id name surname email joinDate tier")
        .lean(),
    ]);
  } catch (err) {
    logOperationalError("service.user-date-range", err);
    console.error("[getUsersByDateRange] DB error:", err.message);
    throw new HttpError("Failed to query users by date range", 500);
  }

  const byRegion = {};
  for (const group of regionGroups) {
    const key = group._id ?? "unknown";
    byRegion[key] = { count: group.count, users: group.users };
  }

  const totalMembers = regionGroups.reduce((sum, g) => sum + g.count, 0);

  console.log(`[getUsersByDateRange] Members: ${totalMembers} across ${regionGroups.length} region(s) | Alumni: ${alumniUsers.length}`);
  for (const [region, data] of Object.entries(byRegion)) {
    console.log(`[getUsersByDateRange]   ${region}: ${data.count}`);
  }
  console.log(`[getUsersByDateRange]   alumni: ${alumniUsers.length}`);

  return {
    startDate: start,
    endDate: end,
    byRegion,
    alumni: {
      count: alumniUsers.length,
      users: alumniUsers,
    },
    totals: {
      members: totalMembers,
      alumni: alumniUsers.length,
      all: totalMembers + alumniUsers.length,
    },
  };
};
