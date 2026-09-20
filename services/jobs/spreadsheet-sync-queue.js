import IORedis from "ioredis";
import { Queue } from "bullmq";
import { redisPrefix } from "../storage/redis.js";

export const SPREADSHEET_SYNC_QUEUE = "spreadsheet-sync";
const JOB_TYPES = new Set(["event", "special-event", "members", "alumni", "internships"]);

const redisUrl = () => {
  const url = process.env.BGSNL_REDIS_URL;
  if (!url) throw new Error("BGSNL_REDIS_URL is required for background jobs");
  return url;
};

export const createWorkerRedisConnection = () => new IORedis(redisUrl(), {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

const queueOptions = (connection) => ({
  connection,
  prefix: `${redisPrefix()}jobs`,
});

let queue;
export const getSpreadsheetSyncQueue = () => {
  if (!queue) queue = new Queue(SPREADSHEET_SYNC_QUEUE, queueOptions(createWorkerRedisConnection()));
  return queue;
};

const nonEmptyText = (value, field) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 200) throw new Error(`${field} is required`);
  return normalized;
};

export const spreadsheetSyncJob = (type, payload = {}) => {
  if (!JOB_TYPES.has(type)) throw new Error("Unknown spreadsheet synchronization job");
  if (["event", "special-event"].includes(type)) {
    const id = nonEmptyText(payload.id, "Spreadsheet record ID");
    return { type, data: { id }, deduplicationId: `${type}_${id}` };
  }
  if (type === "members") {
    const region = payload.region == null ? null : nonEmptyText(payload.region, "Region");
    return { type, data: { region }, deduplicationId: `members_${region || "all"}` };
  }
  return { type, data: {}, deduplicationId: type };
};

export const createSpreadsheetSyncProducer = ({ getQueue = getSpreadsheetSyncQueue } = {}) => ({
  enqueue(type, payload) {
    const job = spreadsheetSyncJob(type, payload);
    return getQueue().add(job.type, job.data, {
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      delay: 750,
      deduplication: { id: job.deduplicationId },
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 1000 },
    });
  },
});

const producer = createSpreadsheetSyncProducer();
export const enqueueSpreadsheetSync = (type, payload) => {
  const pending = producer.enqueue(type, payload);
  // Sync requests are post-commit work. Preserve the successful API action if
  // Redis is temporarily unavailable; the returned promise still lets callers
  // explicitly observe the enqueue failure when they need to.
  pending.catch((error) => console.error("Could not enqueue spreadsheet synchronization", {
    type,
    message: error?.message,
  }));
  return pending;
};

export async function closeSpreadsheetSyncQueue() {
  if (!queue) return;
  const current = queue;
  queue = undefined;
  await current.close();
}
