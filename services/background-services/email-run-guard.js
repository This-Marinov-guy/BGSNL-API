// PM2 runs two API workers; only worker 0 owns non-durable email schedules.
export const isEmailSchedulerProcess = (env = process.env) => env.NODE_APP_INSTANCE == null || env.NODE_APP_INSTANCE === "0";

// Ephemeral scheduling only. No delivery records, statuses or recipient data
// are written to Mongo. A process restart forgets these attempts.
export function createEmailRunGuard() {
  const periods = new Map();
  return {
    has(period, recipient) { return periods.get(period)?.has(recipient) || false; },
    claim(period, recipient) {
      if (!periods.has(period)) {
        periods.set(period, new Set());
        if (periods.size > 32) periods.delete(periods.keys().next().value);
      }
      const attempted = periods.get(period);
      if (attempted.has(recipient)) return false;
      attempted.add(recipient);
      return true;
    },
  };
}
