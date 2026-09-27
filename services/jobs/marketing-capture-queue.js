import IORedis from "ioredis";
import { Queue } from "bullmq";
import MarketingEmail from "../../models/MarketingEmail.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { redisPrefix } from "../storage/redis.js";
import { withJobTimeout } from "./job-timeout.js";

export const MARKETING_CAPTURE_QUEUE = "marketing-capture";
export const MARKETING_JOB_OPTIONS = Object.freeze({
  attempts: 4, // Initial attempt plus at most three retries.
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 1000 },
});
export const MARKETING_ENQUEUE_TIMEOUT_MS = 5000;

export function marketingCaptureData(entry, source = "unknown") {
  if (entry?.consent?.granted !== true) throw new Error("Recorded marketing consent is required");
  const document = new MarketingEmail({ email: entry.email, city: entry.city, consent: {
    granted: true,
    recordedAt: entry.consent.recordedAt || new Date(),
    textVersion: entry.consent.textVersion || "unknown",
    source: String(source).split("?")[0].slice(0, 240),
  } });
  const error = document.validateSync();
  if (error) throw error;
  // Only the fields needed for capture are persisted in Redis.
  return { email: document.email, city: document.city, consent: {
    granted: true, recordedAt: document.consent.recordedAt.toISOString(),
    textVersion: document.consent.textVersion, source: document.consent.source,
  } };
}

let queue;
let connection;
export function getMarketingCaptureQueue() {
  if (!queue) {
    if (!process.env.BGSNL_REDIS_URL) throw new Error("BGSNL_REDIS_URL is required for background jobs");
    connection = new IORedis(process.env.BGSNL_REDIS_URL, {
      maxRetriesPerRequest: 1, enableOfflineQueue: false,
      connectTimeout: MARKETING_ENQUEUE_TIMEOUT_MS, commandTimeout: MARKETING_ENQUEUE_TIMEOUT_MS,
    });
    connection.on("error", (error) => logOperationalError("service.marketing-queue-connection", error));
    queue = new Queue(MARKETING_CAPTURE_QUEUE, { connection, prefix: `${redisPrefix()}jobs` });
    queue.on("error", (error) => logOperationalError("service.marketing-queue", error));
  }
  return queue;
}

export const createMarketingCaptureProducer = ({ getQueue = getMarketingCaptureQueue,
  timeoutMs = MARKETING_ENQUEUE_TIMEOUT_MS } = {}) => ({
  async enqueue(entry, source) {
    const data = marketingCaptureData(entry, source);
    return withJobTimeout(async (signal) => {
      const target = getQueue();
      await target.waitUntilReady();
      signal.throwIfAborted();
      return target.add(MARKETING_CAPTURE_QUEUE, data, MARKETING_JOB_OPTIONS);
    }, timeoutMs);
  },
});

const producer = createMarketingCaptureProducer();
export const enqueueMarketingCapture = (entry, source) => producer.enqueue(entry, source);

export async function closeMarketingCaptureQueue() {
  const current = queue;
  const currentConnection = connection;
  queue = undefined;
  connection = undefined;
  try { if (current) await current.close(); }
  finally { currentConnection?.disconnect(); }
}
