import { randomUUID } from "node:crypto";
import BillingRecord from "../../models/BillingRecord.js";
import HttpError from "../../models/Http-error.js";

export async function withBillingLease(key, work) {
  const owner = randomUUID();
  try {
    await BillingRecord.updateOne({ _id: key }, { $setOnInsert: { leaseUntil: new Date(0) } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
  const record = await BillingRecord.findOneAndUpdate({
    _id: key, leaseUntil: { $lte: new Date() },
  }, { $set: { owner, leaseUntil: new Date(Date.now() + 120000) } }, { new: true });
  if (!record) throw new HttpError("A billing update is already in progress. Please try again shortly.", 409);
  let lost = false;
  const heartbeat = setInterval(() => {
    BillingRecord.updateOne({ _id: key, owner }, { $set: { leaseUntil: new Date(Date.now() + 120000) } })
      .then((result) => { if (!result.matchedCount) lost = true; })
      .catch(() => { lost = true; });
  }, 20000);
  heartbeat.unref();
  const assertOwned = async (session) => {
    // A write inside the account transaction fences out a competing worker;
    // merely reading the lease would not detect a takeover before commit.
    const result = lost ? null : await BillingRecord.updateOne({ _id: key, owner, leaseUntil: { $gt: new Date() } },
      { $set: { leaseUntil: new Date(Date.now() + 120000) } }, { ...(session ? { session } : {}) });
    if (!result?.matchedCount) {
      throw new Error("Billing lease lost; refusing a stale account update");
    }
  };
  try { return await work({ record, assertOwned }); }
  finally {
    clearInterval(heartbeat);
    await BillingRecord.updateOne({ _id: key, owner }, { $set: { leaseUntil: new Date(0) }, $unset: { owner: 1 } });
  }
}
