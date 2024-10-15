import dotenv from "dotenv";
dotenv.config();
import User from "../models/User.js";
import { usersCountCache } from "../util/config/caches.js";

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
