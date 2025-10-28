import mongoose from "mongoose";
import dotenv from "dotenv";
import Event from "../../models/Event.js";
import User from "../../models/User.js";
import { getPresenceStatsOfCity } from "../../services/background-services/google-spreadsheets.js";
import { SPREADSHEETS_ID } from "../../util/config/SPREEDSHEATS.js";
import { eventsCache } from "../../util/config/caches.js";
dotenv.config();

export const getCityData = async (req, res, next) => {
  const city = req.params.city ? req.params.city.toLowerCase() : null;

  if (!city || SPREADSHEETS_ID[city]?.events === undefined) {
    return res.status(400).json({
      status: false,
      message: "Please provide a valid city",
    });
  }

  try {
    const cacheKey = `cityData:${city}`;
    const cachedData = eventsCache.get(cacheKey);
    if (cachedData) {
      return res.status(200).json({
        status: true,
        cached: true,
        city,
        ...cachedData,
      });
    }

    const data = await getPresenceStatsOfCity(SPREADSHEETS_ID[city].events);
    // Cache the data for 24 hours
    eventsCache.set(cacheKey, data, 24 * 3600);

    return res.status(200).json({
      status: true,
      cached: false,
      city,
      ...data,
    });
  } catch (err) {
    console.log('Error in Mobile app: ' + err);
    return res.status(200).json({
      status: false,
      error: err.message,
    });
  }
};
