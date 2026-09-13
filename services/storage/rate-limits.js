import { redisClient, redisPrefix } from "./redis.js";
const increment = `local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIREAT', KEYS[1], ARGV[1]) end
return count`;
export const redisRateLimits = {
  async findOneAndUpdate(query, update) {
    const expiry = +new Date(update.$setOnInsert?.expiresAt);
    if (typeof query._id !== "string" || update.$inc?.count !== 1 || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("Invalid rate-limit window");
    const client = await redisClient();
    return { count: Number(await client.eval(increment, { keys: [`${redisPrefix()}limit:${query._id}`], arguments: [String(expiry)] })) };
  },
};
