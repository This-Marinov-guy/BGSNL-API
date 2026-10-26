import IORedis from "ioredis";
import { Queue } from "bullmq";
import { redisPrefix } from "../storage/redis.js";
import { withJobTimeout } from "../jobs/job-timeout.js";
import { memberRevenueEnabled, memberRevenueLiveMode } from "../../util/config/member-revenue.js";
import { DEFAULT_REGION } from "../../util/config/defines.js";
import { invoiceSubscriptionId } from "../../util/subscriptions/policy.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";

export const MEMBER_REVENUE_QUEUE = "member-revenue";
export const MEMBER_REVENUE_JOB = "member-revenue";
export const MEMBER_REVENUE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const MEMBER_REVENUE_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { age: 30 * 86400 },
  removeOnFail: { age: 30 * 86400 },
};
export const MEMBER_REVENUE_WEBHOOK_TYPES = new Set([
  "invoice.paid", "invoice.payment_succeeded", "invoice.updated",
  "charge.refunded", "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed",
  "charge.dispute.funds_reinstated", "charge.dispute.funds_withdrawn",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "balance.available",
]);

export const shouldQueueMemberRevenue = (event, region, env = process.env) => {
  if (region !== DEFAULT_REGION || event?.account || !memberRevenueEnabled(env) ||
      event?.livemode !== memberRevenueLiveMode(env) || !MEMBER_REVENUE_WEBHOOK_TYPES.has(event.type)) return false;
  if (event.type.startsWith("invoice.")) {
    return event.data?.object?.status === "paid" && Boolean(invoiceSubscriptionId(event.data.object));
  }
  return true;
};

let queue, connection;
export function getMemberRevenueQueue() {
  if (!queue) {
    if (!process.env.BGSNL_REDIS_URL) throw new Error("BGSNL_REDIS_URL is required for background jobs");
    connection = new IORedis(process.env.BGSNL_REDIS_URL, {
      maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 5000, commandTimeout: 5000,
    });
    connection.on("error", error => logOperationalError("service.member-revenue-redis", error));
    queue = new Queue(MEMBER_REVENUE_QUEUE, { connection, prefix: `${redisPrefix()}jobs` });
    queue.on("error", error => logOperationalError("service.member-revenue-queue", error));
  }
  return queue;
}

export async function enqueueMemberRevenueFromWebhook(event, region, {
  getQueue = getMemberRevenueQueue, env = process.env } = {}) {
  if (!shouldQueueMemberRevenue(event, region, env)) return false;
  await withJobTimeout(() => getQueue().add(MEMBER_REVENUE_JOB, {}, {
    ...MEMBER_REVENUE_JOB_OPTIONS,
    deduplication: { id: MEMBER_REVENUE_JOB, keepLastIfActive: true },
  }), 5000);
  return true;
}

export async function scheduleMemberRevenueSweep(getQueue = getMemberRevenueQueue) {
  return getQueue().upsertJobScheduler("member-revenue-recovery",
    { every: MEMBER_REVENUE_SWEEP_INTERVAL_MS },
    { name: MEMBER_REVENUE_JOB, data: {}, opts: MEMBER_REVENUE_JOB_OPTIONS });
}

export async function closeMemberRevenueQueue() {
  if (!queue) return;
  const current = queue, currentConnection = connection;
  queue = undefined;
  connection = undefined;
  await current.close();
  currentConnection?.disconnect();
}
