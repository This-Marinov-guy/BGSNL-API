import dotenv from "dotenv";
dotenv.config();
import User from "../models/User.js";
import { usersCountCache } from "../util/config/caches.js";
import { readSpreadsheetRows } from "../services/background-services/google-spreadsheets.js";
import { STATISTICS_ABOUT_US_SHEET } from "../util/config/SPREEDSHEATS.js";
import Statistics from "../models/Statistics.js";

export const getTotalMemberCount = async (req, res, next) => {
  let userCount = usersCountCache.get("total");

  if (userCount) {
    return res.status(200).json({
      count: userCount,
    });
  }

  try {
    userCount = await User.countDocuments();
    usersCountCache.set("total", userCount);
  } catch (err) {
    console.error("Error counting users:", err.message);
    userCount = "-";
  }

  return res.status(200).json({
    count: userCount,
  });
};

export const getMemberCount = async (req, res, next) => {
  let userCount = usersCountCache.get("members");

  if (userCount) {
    return res.status(200).json({
      count: userCount,
    });
  }

  try {
    userCount = await User.countDocuments({ expireDate: { $gt: new Date() } });
    usersCountCache.set("members", userCount);
  } catch (err) {
    console.error("Error counting users:", err.message);
    userCount = "-";
  }

  return res.status(200).json({
    count: userCount,
  });
};

export const getActiveMemberCount = async (req, res, next) => {
  let userCount = usersCountCache.get("activeMembers");

  if (userCount) {
    return res.status(200).json({
      count: userCount,
    });
  }

  try {
    userCount = await User.countDocuments({
      expireDate: { $gt: new Date() },
      $expr: { $gt: [{ $size: "$roles" }, 1] },
    });
    usersCountCache.set("activeMembers", userCount);
  } catch (err) {
    console.error("Error counting users:", err.message);
    userCount = "-";
  }

  return res.status(200).json({
    count: userCount,
  });
};

export const getAboutUsData = async (req, res, next) => {
  try {
    const [eventStatistics, memberStatistics, alumniStatistics] =
      await Promise.all([
        Statistics.findOne({ type: "event" }),
        Statistics.findOne({ type: "member" }),
        Statistics.findOne({ type: "alumni" }),
      ]);

    return res.status(200).json({
      cities: eventStatistics?.data?.regions ?? [],
      events: eventStatistics?.data?.count ?? 0,
      members: memberStatistics?.data?.total ?? 0,
      tickets: eventStatistics?.data?.totalTickets ?? 0,
      alumni: alumniStatistics?.data?.total ?? 0,
    });
  } catch (err) {
    console.log(err);
    return res.status(200).json({});
  }
};
