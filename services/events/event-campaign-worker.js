import { isEmailSchedulerProcess } from "../background-services/email-run-guard.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { runObservedJob } from "../monitoring/job-history.js";
import { createEventCampaignService } from "./event-campaigns.js";
export const eventCampaignsEnabled = (env = process.env) => env.EVENT_CAMPAIGNS_ENABLED === "true" || (env.EVENT_CAMPAIGNS_ENABLED === undefined && env.NODE_ENV === "production");
export function startEventCampaignWorker({ enabled = eventCampaignsEnabled() && isEmailSchedulerProcess(), service = createEventCampaignService(), intervalMs = 60000 } = {}) {
  if (!enabled) return async () => {};
  let running;
  const tick = () => {
    if (running) return;
    running = runObservedJob("scheduler", "event-email-campaigns", () => service.tick())
      .catch(error => logOperationalError("worker.event-campaigns", error)).finally(() => { running = null; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => { clearInterval(timer); await running; };
}
