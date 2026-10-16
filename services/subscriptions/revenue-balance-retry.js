import { redisRecordStore } from "../storage/redis-records.js";
import { isBusyLease } from "../jobs/recovery-backoff.js";
import { DEFAULT_REGION } from "../../util/config/defines.js";
import { createStripeClient } from "../../util/config/stripe.js";
import { memberRevenueEnabled, memberRevenueLiveMode } from "../../util/config/member-revenue.js";

const waits = redisRecordStore("member-revenue-balance-wait", { ttlMs: 7 * 86400_000 });
const waitId = livemode => `outstanding:${livemode ? "live" : "test"}`;
const availableCardCents = (balance, livemode) => {
  if (balance.livemode !== livemode) throw new Error("Wrong Stripe mode for member revenue balance retry");
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

export async function retryMemberRevenueWhenFunded({ enabled = memberRevenueEnabled(), livemode = memberRevenueLiveMode(),
  records = waits, stripeFor = createStripeClient, retry } = {}) {
  if (!enabled) return { noWork: true };
  const pending = await records.findById(waitId(livemode));
  if (!pending) return { noWork: true };
  if (!Number.isSafeInteger(pending.minimumCents) || pending.minimumCents <= 0) throw new Error("Invalid deferred transfer wait");
  const stripe = stripeFor(DEFAULT_REGION);
  const available = availableCardCents(await stripe.balance.retrieve(), livemode);
  if (available < pending.minimumCents || pending.lastAttemptedMinimum === pending.minimumCents &&
      pending.lastObservedAvailable !== undefined && available <= pending.lastObservedAvailable) {
    if (available !== pending.lastObservedAvailable) await records.updateOne({ _id: waitId(livemode), minimumCents: pending.minimumCents },
      { $set: { lastObservedAvailable: available } });
    return { noWork: true };
  }
  if (typeof retry !== "function") throw new Error("Member revenue retry is not configured");
  try {
    const result = await retry();
    const after = availableCardCents(await stripe.balance.retrieve(), livemode);
    // If settlement changed the minimum or removed the wait, do not overwrite
    // that newer state. Compare future balances with the amount left after the
    // retry, since successful transfers can consume the available funds.
    await records.updateOne({ _id: waitId(livemode), minimumCents: pending.minimumCents },
      { $set: { lastObservedAvailable: after, lastAttemptedMinimum: pending.minimumCents } });
    return { retried: true, remainingFailures: result?.failed || 0 };
  } catch (error) {
    if (isBusyLease(error)) return { skipped: true };
    throw error;
  }
}
