import "dotenv/config";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "redis";

const execute = promisify(execFile);
export const LOCAL_REDIS_URL = "redis://127.0.0.1:6380/0";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, ".local/redis");
const config = path.join(directory, "redis.conf");

async function connect(url) {
  const client = createClient({ url, disableOfflineQueue: true,
    socket: { connectTimeout: 1000, reconnectStrategy: false } });
  client.on("error", () => {});
  try { await client.connect(); await client.ping(); return client; }
  catch { if (client.isOpen) client.destroy(); return null; }
}

export async function ensureLocalRedis({ env = process.env } = {}) {
  const url = env.BGSNL_REDIS_URL || LOCAL_REDIS_URL;
  let client = await connect(url);
  if (client) { await client.quit(); return; }
  if (url !== LOCAL_REDIS_URL) throw new Error("Configured Redis is unavailable. Check BGSNL_REDIS_URL or use redis://127.0.0.1:6380/0 for local development.");
  await mkdir(path.join(directory, "data"), { recursive: true, mode: 0o700 });
  await writeFile(config, [
    "bind 127.0.0.1", "port 6380", "protected-mode yes", "daemonize yes",
    `dir ${JSON.stringify(path.join(directory, "data"))}`,
    `pidfile ${JSON.stringify(path.join(directory, "redis.pid"))}`,
    'logfile "/dev/null"', "appendonly yes", "appendfsync always",
    'save ""', "maxmemory 128mb", "maxmemory-policy noeviction", "",
  ].join("\n"), { mode: 0o600 });
  try { await execute(env.BGSNL_REDIS_SERVER || "redis-server", [config], { env, timeout: 10000 }); }
  catch { throw new Error("Could not start local Redis. Install redis-server (macOS: brew install redis), or set BGSNL_REDIS_SERVER to its executable path. Port 6380 must be free."); }
  for (let attempt = 0; attempt < 10; attempt++) {
    client = await connect(url);
    if (client) { await client.quit(); return; }
    await delay(250);
  }
  throw new Error("Local Redis did not become ready on port 6380.");
}

async function main(command = "ensure") {
  if (["start", "ensure"].includes(command)) {
    await ensureLocalRedis({ env: command === "start" ? { ...process.env, BGSNL_REDIS_URL: LOCAL_REDIS_URL } : process.env });
    console.log("Redis is ready for local development.");
    return;
  }
  if (!["status", "stop"].includes(command)) throw new Error("Use start, ensure, status or stop.");
  const client = await connect(LOCAL_REDIS_URL);
  if (!client) { console.log("Local Redis is stopped."); if (command === "status") process.exitCode = 1; return; }
  try {
    if (command === "status") { console.log("Local Redis: PONG (127.0.0.1:6380)"); return; }
    const info = await client.info("server");
    const actualConfig = info.match(/^config_file:(.+)\r?$/m)?.[1].trim();
    if (actualConfig !== config) throw new Error("Port 6380 belongs to another Redis instance; refusing to stop it.");
    try { await client.sendCommand(["SHUTDOWN"]); }
    catch (error) {
      const stillRunning = await connect(LOCAL_REDIS_URL);
      if (stillRunning) { await stillRunning.quit(); throw error; }
    }
    console.log("Local Redis stopped; its persisted data is retained.");
  } finally { if (client.isOpen) client.destroy(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
