import { BillingLeaseBusyError } from "../subscriptions/lease-retry.js";

export const isBusyLease = error => error instanceof BillingLeaseBusyError;
// These are background lookup retries, not customer collection attempts.
export function recoveryDelay(attempts, error) {
  if (isBusyLease(error)) return 60_000;
  if (error?.code === "resource_missing") return 24 * 60 * 60_000;
  return Math.min(5 * 60_000 * 2 ** Math.min(Math.max(0, attempts - 1), 7), 6 * 60 * 60_000);
}
