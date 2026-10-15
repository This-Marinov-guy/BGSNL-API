import { academicYearLabel, academicYearRange } from "../../util/config/academic-year.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { runObservedJob } from "../monitoring/job-history.js";
import { isEmailSchedulerProcess } from "./email-run-guard.js";
import { initializeAcademicYearStatistics } from "./regional-averages.js";

const MAX_TIMEOUT_MS = 2_147_483_647;
const RETRY_MS = 60 * 60 * 1000;

/** Seed on startup and at 25 August midnight in Amsterdam; a restart is safe. */
export function startAcademicYearStatisticsWorker({
  enabled = isEmailSchedulerProcess(),
  now = () => new Date(),
  initialize = initializeAcademicYearStatistics,
  observe = runObservedJob,
  schedule = setTimeout,
  cancel = clearTimeout,
  onError = error => logOperationalError("worker.academic-year-statistics", error),
} = {}) {
  if (!enabled) return async () => {};
  let stopped = false;
  let timer;
  let running;
  let initializedYear;

  const tick = () => {
    if (stopped || running) return;
    const current = now();
    const year = academicYearLabel(current);
    running = Promise.resolve()
      .then(() => year === initializedYear ? null
        : observe("scheduler", "academic-year-statistics", () => initialize(current)))
      .then(() => { initializedYear = year; })
      .catch(error => { onError(error); })
      .finally(() => {
        running = null;
        if (stopped) return;
        const current = now();
        const currentYear = academicYearLabel(current);
        const untilBoundary = academicYearRange(current).end.getTime() - current.getTime();
        const delay = currentYear !== year ? 1 : initializedYear === currentYear
          ? Math.min(MAX_TIMEOUT_MS, Math.max(1, untilBoundary)) : RETRY_MS;
        timer = schedule(tick, delay);
        timer.unref?.();
      });
  };
  tick();
  return async () => {
    stopped = true;
    if (timer) cancel(timer);
    await running;
  };
}
