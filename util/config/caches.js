import { redisCache } from "../../services/storage/cache.js";
export const eventsCache = redisCache("events", 24 * 3600);
export const usersCountCache = redisCache("user-counts", 24 * 3600);
