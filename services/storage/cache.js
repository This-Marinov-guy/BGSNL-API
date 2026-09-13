import { EJSON } from "bson";
import { redisClient, redisPrefix } from "./redis.js";
export function redisCache(namespace, defaultSeconds) {
  if (!Number.isSafeInteger(defaultSeconds) || defaultSeconds <= 0) throw new Error("A finite cache lifetime is required");
  const key = (value) => `${redisPrefix()}cache:${namespace}:${value}`;
  return {
    async get(value) {
      try { const raw = await (await redisClient()).get(key(value)); return raw ? EJSON.parse(raw) : undefined; }
      catch { return undefined; } // Optional cache miss; the source remains authoritative.
    },
    async set(value, data, seconds = defaultSeconds) {
      if (!Number.isSafeInteger(seconds) || seconds <= 0) return;
      const raw = EJSON.stringify(data);
      if (Buffer.byteLength(raw) > 1024 * 1024) return; // Large reports must not crowd out sessions.
      try { await (await redisClient()).set(key(value), raw, { EX: seconds }); }
      catch { /* Cache storage never changes a successful source read. */ }
    },
  };
}
