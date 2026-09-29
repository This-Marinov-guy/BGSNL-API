import { Worker } from "bullmq";
import { redisPrefix } from "../storage/redis.js";
import { SPREADSHEET_SYNC_QUEUE, createWorkerRedisConnection } from "./spreadsheet-sync-queue.js";
import { logIntegrationError, logOperationalError } from "../../middleware/axiom-logger.js";
import { GUEST_LIST_RECONCILIATION_JOB, reconcileGuestLists } from "./guest-list-reconciliation.js";
import {
  syncAlumniToSpreadsheet,
  syncEventToSpreadsheet,
  syncInternshipApplicationsToSpreadsheet,
  syncSpecialEventToSpreadsheet,
  syncUsersToSpreadsheet,
} from "../background-services/google-spreadsheets.js";

export const spreadsheetSyncHandlers = Object.freeze({
  event: syncEventToSpreadsheet,
  "special-event": syncSpecialEventToSpreadsheet,
  members: syncUsersToSpreadsheet,
  alumni: syncAlumniToSpreadsheet,
  internships: syncInternshipApplicationsToSpreadsheet,
  [GUEST_LIST_RECONCILIATION_JOB]: reconcileGuestLists,
});

export const createSpreadsheetSyncProcessor = (handlers = spreadsheetSyncHandlers) => async (job) => {
  const handler = handlers[job?.name];
  if (!handler) throw new Error(`Unknown spreadsheet synchronization job: ${job?.name || "unknown"}`);
  await handler(job.data || {});
};

export const startSpreadsheetSyncWorker = ({
  connection = createWorkerRedisConnection(),
  processor = createSpreadsheetSyncProcessor(),
  WorkerClass = Worker,
  concurrency = 1,
} = {}) => {
  const worker = new WorkerClass(SPREADSHEET_SYNC_QUEUE, processor, {
    connection,
    prefix: `${redisPrefix()}jobs`,
    concurrency,
  });
  worker.on("failed", (job, error) => {
    logIntegrationError("google-sheets", error, job?.name || "sync");
    console.error("Spreadsheet synchronization failed", {
      jobId: job?.id,
      type: job?.name,
      attempts: job?.attemptsMade,
      code: error?.code,
    });
  });
  worker.on("error", (error) => {
    logOperationalError("worker.spreadsheet-connection", error);
    console.error("Spreadsheet synchronization worker connection failed", { message: error?.message });
  });
  return {
    worker,
    async stop() {
      await worker.close();
      await connection.quit();
    },
  };
};
