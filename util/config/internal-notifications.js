const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const DEFAULT_INTERNAL_NOTIFICATION_SUBSCRIBERS = Object.freeze([
  "vladislavmarinov3142@gmail.com",
  "bulgariansocietynetherlands@gmail.com",
]);

export const DEFAULT_DEVELOPER_NOTIFICATION_SUBSCRIBERS = Object.freeze([
  "vladislavmarinov3142@gmail.com",
]);

export const getDeveloperNotificationConfig = (env = process.env) => ({
  enabled: env.DEVELOPER_NOTIFICATIONS_ENABLED === undefined
    ? true : areInternalNotificationsEnabled(env.DEVELOPER_NOTIFICATIONS_ENABLED),
  subscribers: env.DEVELOPER_NOTIFICATION_SUBSCRIBERS === undefined
    ? [...DEFAULT_DEVELOPER_NOTIFICATION_SUBSCRIBERS]
    : String(env.DEVELOPER_NOTIFICATION_SUBSCRIBERS).trim()
      ? parseInternalNotificationSubscribers(env.DEVELOPER_NOTIFICATION_SUBSCRIBERS) : [],
});

export const parseInternalNotificationSubscribers = (value) => {
  const candidates = value
    ? String(value).split(",")
    : DEFAULT_INTERNAL_NOTIFICATION_SUBSCRIBERS;

  return [...new Set(
    candidates
      .map((email) => email.trim().toLowerCase())
      .filter((email) => EMAIL_PATTERN.test(email))
  )];
};

export const areInternalNotificationsEnabled = (value) =>
  ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());

export const getInternalNotificationConfig = (env = process.env) => ({
  enabled: areInternalNotificationsEnabled(env.INTERNAL_NOTIFICATIONS_ENABLED),
  subscribers: parseInternalNotificationSubscribers(
    env.INTERNAL_NOTIFICATION_SUBSCRIBERS
  ),
});
