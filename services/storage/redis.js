import { createClient } from "redis";
let client;
let connection;
export async function redisClient() {
  if (!client) {
    const url = process.env.BGSNL_REDIS_URL;
    if (!url) throw new Error("BGSNL_REDIS_URL is required");
    client = createClient({ url, disableOfflineQueue: true,
      socket: { connectTimeout: 5000, reconnectStrategy: (attempt) => attempt >= 3 ? new Error("Redis unavailable") : Math.min(100 * (attempt + 1), 3000) } });
    client.on("error", () => console.error("BGSNL Redis connection unavailable"));
  }
  if (!client.isOpen) connection ||= client.connect().finally(() => { connection = null; });
  if (connection) await connection;
  if (!client.isReady) throw new Error("BGSNL Redis is unavailable");
  return client;
}
export async function closeRedis() { if (client?.isOpen) await client.quit(); client = undefined; }
export const redisPrefix = () => process.env.BGSNL_REDIS_PREFIX || "bgsnl:v1:";
