import "dotenv/config";
import { createClient } from "redis";

// Run inside each release container to check its credentials and Docker network,
// not just Redis's own healthcheck. No keys are read or written.
async function main() {
  // eslint-disable-next-line no-process-env
  const url = process.env.BGSNL_REDIS_URL;
  if (!url) throw new Error("Redis is not configured");
  const client = createClient({ url, socket: { connectTimeout: 5000, reconnectStrategy: false } });
  client.on("error", () => {});
  let timer;
  try {
    await Promise.race([
      (async () => {
        await client.connect();
        if (await client.ping() !== "PONG") throw new Error("Redis ping failed");
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Redis check timed out")), 7000); }),
    ]);
    console.log("BGSNL Redis connection verified (PONG).");
  } finally {
    clearTimeout(timer);
    if (client.isOpen) client.destroy();
  }
}

main().catch(() => {
  console.error("BGSNL Redis connection failed. Check the private Redis URL, credentials and network; deployment blocked.");
  process.exitCode = 1;
});
