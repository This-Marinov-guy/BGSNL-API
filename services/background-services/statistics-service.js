import User from "../../models/User.js";
import AlumniUser from "../../models/AlumniUser.js";
import Statistics from "../../models/Statistics.js";

/**
 * Internal function to recount and update member statistics
 */
const _recountMemberStatistics = async () => {
  try {
    const today = new Date();
    const memberCount = await User.countDocuments({
      expireDate: { $gt: today },
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
    console.error("Error recounting member statistics:", err);
    return { success: false, error: err.message };
  }
};

/**
 * Internal function to recount and update alumni statistics
 */
const _recountAlumniStatistics = async () => {
  try {
    const alumniCount = await AlumniUser.countDocuments();

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
      await _recountMemberStatistics();
    } catch (err) {
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
      await _recountAlumniStatistics();
    } catch (err) {
      console.error("Background job error in recountAlumniStatistics:", err);
    }
  });
};

