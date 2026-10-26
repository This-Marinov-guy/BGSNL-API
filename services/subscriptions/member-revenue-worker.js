import { Worker } from "bullmq";
import { processMemberRevenueMaintenance } from "./revenue-fees.js";
import { createWorkerRedisConnection } from "../jobs/spreadsheet-sync-queue.js";
import { redisPrefix } from "../storage/redis.js";
import { MEMBER_REVENUE_JOB, MEMBER_REVENUE_QUEUE } from "./member-revenue-queue.js";
import { notifyFinalQueueFailure } from "../monitoring/queue-failure-alert.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { notifyMemberRevenueIssues } from "./member-revenue-alerts.js";

export const createMemberRevenueProcessor = ({ process = processMemberRevenueMaintenance,
  notifyIssues = notifyMemberRevenueIssues } = {}) => async job => {
  if (job?.name !== MEMBER_REVENUE_JOB) throw new Error("Unknown Member revenue job");
  const result = await process();
  const issues = result?.issues?.length ? result.issues : result?.failed > 0 ? [{ kind: "settlement" }] : [];
  if (issues.length) {
    // Email delivery is independent of the queue slot and never delays the
    // next paid invoice. A daily sweep retries unresolved issues.
    void Promise.resolve().then(() => notifyIssues(issues))
      .catch(error => logOperationalError("worker.member-revenue-alert", error));
  }
  return result;
};

export function startMemberRevenueWorker({ connection = createWorkerRedisConnection(),
  processor = createMemberRevenueProcessor(), WorkerClass = Worker } = {}) {
  const worker = new WorkerClass(MEMBER_REVENUE_QUEUE, processor,
    { connection, prefix: `${redisPrefix()}jobs`, concurrency: 1 });
  worker.on("failed", (job, error) => {
    logOperationalError("worker.member-revenue", error);
    void notifyFinalQueueFailure(job, MEMBER_REVENUE_QUEUE)
      .catch(alertError => logOperationalError("worker.member-revenue-job-alert", alertError));
  });
  worker.on("error", error => logOperationalError("worker.member-revenue-connection", error));
  return { worker, async stop() { await worker.close(); await connection.quit(); } };
}
