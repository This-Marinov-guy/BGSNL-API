import { isEmailSchedulerProcess } from "../background-services/email-run-guard.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { runObservedJob } from "../monitoring/job-history.js";
import { createEventCampaignService } from "./event-campaigns.js";
import { startDailyCheck } from "../jobs/calendar-check.js";
export const eventCampaignsEnabled = (env = process.env) => env.EVENT_CAMPAIGNS_ENABLED === "true" || (env.EVENT_CAMPAIGNS_ENABLED === undefined && env.NODE_ENV === "production");
export function startEventCampaignWorker({ enabled = eventCampaignsEnabled() && isEmailSchedulerProcess(), service = createEventCampaignService(), intervalMs } = {}) {
  if (!enabled) return async () => {};
  let running;
  const tick = () => {
    if (running) return;
    running = runObservedJob("scheduler", "event-email-campaigns", () => service.tick())
      .catch(error => logOperationalError("worker.event-campaigns", error)).finally(() => { running = null; });
  };
  const stopSchedule = startDailyCheck(tick, { intervalMs });
  return async () => { stopSchedule(); await running; };
}
