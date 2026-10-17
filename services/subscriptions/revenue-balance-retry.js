import { redisRecordStore } from "../storage/redis-records.js";
import { requestCoordinatedSchedule } from "../jobs/coordinated-schedule.js";
import { memberRevenueEnabled, memberRevenueLiveMode } from "../../util/config/member-revenue.js";

const waits = redisRecordStore("member-revenue-balance-wait", { ttlMs: 7 * 86400_000 });
const waitId = livemode => `outstanding:${livemode ? "live" : "test"}`;
const availableCardCents = balance => {
  if (balance?.object !== "balance" || !Array.isArray(balance.available)) throw new Error("Invalid Stripe balance event");
  const eur = balance.available.find(item => item.currency === "eur");
  // Transfers without an unsettled source charge draw from the card balance.
  const available = eur?.source_types ? eur.source_types.card ?? 0 : eur?.amount ?? 0;
  if (!Number.isSafeInteger(available)) throw new Error("Invalid available Stripe balance");
  return available;
};

// This is a wake-up hint, not a payment ledger. The regular settlement sweep
// rebuilds every amount from Stripe and refreshes the hint every 15 minutes.
export async function recordMemberRevenueBalanceWait({ minimumDeferredAmount },
  { records = waits, livemode = memberRevenueLiveMode() } = {}) {
  if (minimumDeferredAmount !== undefined) {
    if (!Number.isSafeInteger(minimumDeferredAmount) || minimumDeferredAmount <= 0) throw new Error("Invalid deferred transfer amount");
    await records.updateOne({ _id: waitId(livemode) }, { $set: { minimumCents: minimumDeferredAmount } }, { upsert: true });
  } else {
    await records.deleteOne({ _id: waitId(livemode) });
  }
}

export async function scheduleMemberRevenueOnBalance(event, { enabled = memberRevenueEnabled(), livemode = memberRevenueLiveMode(),
  records = waits, wake = requestCoordinatedSchedule } = {}) {
  if (!enabled || event?.type !== "balance.available" || event.livemode !== livemode || event.account) return { noWork: true };
  const pending = await records.findById(waitId(livemode));
  if (!pending) return { noWork: true };
  if (!Number.isSafeInteger(pending.minimumCents) || pending.minimumCents <= 0) throw new Error("Invalid deferred transfer wait");
  if (availableCardCents(event.data?.object) < pending.minimumCents) return { noWork: true };
  await wake("member-revenue-maintenance");
  return { scheduled: true };
}
