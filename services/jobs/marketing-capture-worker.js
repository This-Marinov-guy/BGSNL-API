import { Worker } from "bullmq";
import MarketingEmail from "../../models/MarketingEmail.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { redisPrefix } from "../storage/redis.js";
import { createWorkerRedisConnection } from "./spreadsheet-sync-queue.js";
import { MARKETING_CAPTURE_QUEUE, marketingCaptureData } from "./marketing-capture-queue.js";
import { withJobTimeout } from "./job-timeout.js";

export const MARKETING_ATTEMPT_TIMEOUT_MS = 10_000;
export const MARKETING_DATABASE_TIMEOUT_MS = 5000;

export const createMarketingCaptureProcessor = ({ model = MarketingEmail,
  timeoutMs = MARKETING_ATTEMPT_TIMEOUT_MS } = {}) => async (job) => {
  if (job?.name !== MARKETING_CAPTURE_QUEUE) throw new Error("Unknown marketing capture job");
  const data = marketingCaptureData(job.data, job.data?.consent?.source);
  await withJobTimeout(async (signal) => {
    // Do not let Mongoose buffer a write and send it after this attempt expires.
    if (model === MarketingEmail && model.db.readyState !== 1) throw new Error("Marketing database unavailable");
    signal.throwIfAborted();
    await model.add(data, { maxTimeMS: MARKETING_DATABASE_TIMEOUT_MS });
  }, timeoutMs);
};

export function startMarketingCaptureWorker({ connection = createWorkerRedisConnection(),
  processor = createMarketingCaptureProcessor(), WorkerClass = Worker } = {}) {
  const worker = new WorkerClass(MARKETING_CAPTURE_QUEUE, processor, {
    connection, prefix: `${redisPrefix()}jobs`, concurrency: 2,
  });
  worker.on("failed", (_job, error) => logOperationalError("worker.marketing-capture", error));
  worker.on("error", (error) => logOperationalError("worker.marketing-capture-connection", error));
  return {
    worker,
    async stop() {
      try { await worker.close(); }
      finally { connection.disconnect(); }
    },
  };
}
