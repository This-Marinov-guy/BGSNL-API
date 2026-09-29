import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import HttpError from "../../models/Http-error.js";

const webhookScope = new AsyncLocalStorage();
const RETRY_DELAYS_MS = [200, 400, 800, 1200, 1600, 2000];
const MAX_WAIT_MS = 8000;

export class BillingLeaseBusyError extends HttpError {
  constructor() {
    super("A billing update is already in progress. Please try again shortly.", 409);
    this.name = "BillingLeaseBusyError";
  }
}

// One budget for the entire verified delivery, including nested billing work.
// Other HTTP requests and background sweeps keep their existing fail-fast path.
export function withWebhookBillingRetries(work, { now = () => performance.now(), wait = sleep, random = Math.random } = {}) {
  if (webhookScope.getStore()) return work();
  return webhookScope.run({ deadline: now() + MAX_WAIT_MS, retries: 0, now, wait, random }, work);
}

export async function acquireBillingLease(attempt) {
  const scope = webhookScope.getStore();
  // Retry only SET NX returning "busy". Redis errors and errors inside the
  // lease callback propagate immediately; completed side effects never replay.
  while (!await attempt()) {
    if (!scope || scope.retries >= RETRY_DELAYS_MS.length || scope.now() >= scope.deadline) throw new BillingLeaseBusyError();
    const delay = Math.min(RETRY_DELAYS_MS[scope.retries++] * (1 + scope.random() * 0.25), scope.deadline - scope.now());
    await scope.wait(delay);
    if (scope.now() >= scope.deadline) throw new BillingLeaseBusyError();
  }
}
