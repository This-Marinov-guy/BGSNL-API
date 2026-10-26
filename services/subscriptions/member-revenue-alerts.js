import { createHash, randomUUID } from "node:crypto";
import { sendDeveloperMemberRevenueAlert } from "../background-services/developer-notifications.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { redisPrefix } from "../storage/redis.js";
import { getMemberRevenueQueue } from "./member-revenue-queue.js";

const ALERT_INTERVAL_SECONDS = 24 * 60 * 60;
const ALERT_LOCK_SECONDS = 5 * 60;
const keyFor = issue => `${redisPrefix()}member-revenue-alert:${createHash("sha256").update(JSON.stringify([
  issue.kind, issue.invoiceId || "", issue.subscriptionId || "", issue.accountId || "",
])).digest("hex")}`;

// A short Redis lease coalesces concurrent sweeps. A successful email is
// reminded once a day while the transfer remains unresolved.
export async function notifyMemberRevenueIssues(issues, {
  getQueue = getMemberRevenueQueue, send = sendDeveloperMemberRevenueAlert,
} = {}) {
  if (!issues?.length) return 0;
  const redis = await getQueue().client;
  let sent = 0;
  for (const issue of issues) {
    const key = keyFor(issue);
    const owner = randomUUID();
    if (await redis.set(key, owner, "EX", ALERT_LOCK_SECONDS, "NX") !== "OK") continue;
    try {
      const count = await send(issue);
      if (!count) {
        await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
          1, key, owner);
        continue;
      }
      sent += count;
      await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) else return 0 end",
        1, key, owner, ALERT_INTERVAL_SECONDS);
    } catch (error) {
      await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        1, key, owner).catch(releaseError => logOperationalError("service.member-revenue-alert-release", releaseError));
      logOperationalError("service.member-revenue-alert", error);
    }
  }
  return sent;
}
