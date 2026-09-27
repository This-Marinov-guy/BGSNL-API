export const DAY_MS = 86400000;
export const CHECKOUT_RETENTION_MS = 30 * DAY_MS;
export const REMINDER_RETENTION_MS = 30 * DAY_MS;

export const checkoutDeadline = (record) =>
  +new Date(record.completedAt || record.data?.reservedAt || record.createdAt) + CHECKOUT_RETENTION_MS;

export const reminderDeadline = (record) => {
  const deadline = +new Date(record.startedAt || record.createdAt || record.resolvedAt) + REMINDER_RETENTION_MS;
  return record.resolvedAt ? Math.min(deadline, +new Date(record.resolvedAt) + DAY_MS) : deadline;
};
