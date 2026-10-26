import { Worker } from "bullmq";
import { processMemberRevenueMaintenance } from "./revenue-fees.js";
import { createWorkerRedisConnection } from "../jobs/spreadsheet-sync-queue.js";
import { redisPrefix } from "../storage/redis.js";
import { MEMBER_REVENUE_JOB, MEMBER_REVENUE_QUEUE } from "./member-revenue-queue.js";
import { notifyFinalQueueFailure } from "../monitoring/queue-failure-alert.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";

export const createMemberRevenueProcessor = ({ process = processMemberRevenueMaintenance } = {}) => async job => {
  if (job?.name !== MEMBER_REVENUE_JOB) throw new Error("Unknown Member revenue job");
  const result = await process();
  if (result?.failed > 0) throw new Error("Member revenue has deferred or failed regional settlements");
};

export function startMemberRevenueWorker({ connection = createWorkerRedisConnection(),
  processor = createMemberRevenueProcessor(), WorkerClass = Worker } = {}) {
  const worker = new WorkerClass(MEMBER_REVENUE_QUEUE, processor,
    { connection, prefix: `${redisPrefix()}jobs`, concurrency: 1 });
  worker.on("failed", (job, error) => {
    logOperationalError("worker.member-revenue", error);
    void notifyFinalQueueFailure(job, MEMBER_REVENUE_QUEUE);
  });
  worker.on("error", error => logOperationalError("worker.member-revenue-connection", error));
  return { worker, async stop() { await worker.close(); await connection.quit(); } };
}
