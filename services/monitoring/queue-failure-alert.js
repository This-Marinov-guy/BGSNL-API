import { jobFailurePolicy } from "./job-failure-policy.js";

export async function notifyFinalQueueFailure(job, source, { policy = jobFailurePolicy } = {}) {
  if (!job || job.attemptsMade < (job.opts?.attempts || 5)) return false;
  await policy.queueFailure(source, job.name, job.id, job.attemptsMade);
  return true;
}
