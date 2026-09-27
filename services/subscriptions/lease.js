import { createHash, randomUUID } from "node:crypto";
import BillingRecord from "../../models/BillingRecord.js";
import TemporaryCode from "../../models/TemporaryCode.js";
import HttpError from "../../models/Http-error.js";
import { redisClient, redisPrefix } from "../storage/redis.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";

const renew = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const release = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
export async function withBillingLease(key, work, { clientFor = redisClient, records = BillingRecord, fences = TemporaryCode.collection } = {}) {
  const client = await clientFor(), owner = randomUUID();
  const lockKey = `${redisPrefix()}lease:${createHash("sha256").update(key).digest("hex")}`;
  if (!await client.set(lockKey, owner, { NX: true, PX: 120000 })) throw new HttpError("A billing update is already in progress. Please try again shortly.", 409);
  let lost = false, heartbeat;
  const assertOwned = async (session) => {
    if (lost || !await client.eval(renew, { keys: [lockKey], arguments: [owner, "120000"] })) throw new Error("Billing lease lost; refusing a stale account update");
    if (session) {
      // Redis cannot fence a Mongo transaction. A single tiny expiring marker
      // makes a takeover conflict with the old worker's account transaction.
      const result = await fences.updateOne({ _id: lockKey, owner }, { $inc: { revision: 1 } }, { session });
      if (!result.matchedCount) throw new Error("Billing transaction fence lost");
    }
  };
  try {
    await fences.updateOne({ _id: lockKey }, { $set: { owner, expiresAt: new Date(Date.now() + 86400000) } }, { upsert: true });
    heartbeat = setInterval(() => { assertOwned().catch((error) => { lost = true; logOperationalError("service.billing-lease-heartbeat", error); }); }, 20000);
    heartbeat.unref();
    const record = await records.findById(key) || { _id: key };
    return await work({ record: { ...record, owner }, assertOwned });
  } finally {
    clearInterval(heartbeat);
    await client.eval(release, { keys: [lockKey], arguments: [owner] }).catch((error) => {
      logOperationalError("service.billing-lease-release", error);
      console.error("Redis lease release deferred to expiry");
    });
  }
}
