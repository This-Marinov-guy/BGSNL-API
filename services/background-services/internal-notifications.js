import { sendInternalNotificationEmail } from "./email-transporter.js";
import { getInternalNotificationConfig } from "../../util/config/internal-notifications.js";

const DISPLAY_TIME_ZONE = "Europe/Amsterdam";

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const present = (value, fallback = "Not provided") => {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
};

const formatDateTime = (value) => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "Not provided";

  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: DISPLAY_TIME_ZONE,
  }).format(date);
};

const renderNotification = ({ eyebrow, title, rows }) => {
  const textRows = rows.map(([label, value]) => `${label}: ${present(value)}`);
  const htmlRows = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:8px 16px 8px 0;color:#64748b;font-size:14px;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
          <td style="padding:8px 0;color:#0f172a;font-size:14px;vertical-align:top;">${escapeHtml(present(value))}</td>
        </tr>`
    )
    .join("");

  return {
    text: [eyebrow, title, "", ...textRows].join("\n"),
    html: `<!doctype html>
      <html lang="en">
        <body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,sans-serif;">
          <div style="max-width:640px;margin:0 auto;overflow:hidden;border-radius:16px;background:#ffffff;">
            <div style="padding:24px;background:#2563eb;color:#ffffff;">
              <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">${escapeHtml(eyebrow)}</div>
              <h1 style="margin:8px 0 0;font-size:24px;line-height:1.3;font-weight:600;">${escapeHtml(title)}</h1>
            </div>
            <div style="padding:20px 24px 24px;">
              <table role="presentation" style="width:100%;border-collapse:collapse;">${htmlRows}</table>
            </div>
          </div>
        </body>
      </html>`,
  };
};

export const buildInternshipApplicationNotification = (application) => {
  const position = present(application?.position, "Unspecified position");
  const message = renderNotification({
    eyebrow: "Internal notification",
    title: "New internship application",
    rows: [
      ["Applicant", application?.name],
      ["Email", application?.email],
      ["Phone", application?.phone],
      ["Company", application?.companyName],
      ["Position", position],
      ["Submitted", formatDateTime(application?.createdAt ?? new Date())],
      ["Application ID", application?._id ?? application?.id],
    ],
  });

  return {
    ...message,
    subject: `New internship application — ${position}`,
    type: "internship-application-created",
    entityId: present(application?._id ?? application?.id, "unknown"),
  };
};

export const buildEventCreatedNotification = (event) => {
  const title = present(event?.title, "Untitled event");
  const message = renderNotification({
    eyebrow: "Internal notification",
    title: "New event added",
    rows: [
      ["Event", title],
      ["Region", event?.region],
      ["Date", formatDateTime(event?.date)],
      ["Location", event?.location],
      ["Visibility", event?.hidden ? "Hidden" : "Visible"],
      ["Audience", event?.memberOnly ? "Members only" : "Everyone"],
      ["Event ID", event?._id ?? event?.id],
    ],
  });

  return {
    ...message,
    subject: `New event added — ${title}`,
    type: "event-created",
    entityId: present(event?._id ?? event?.id, "unknown"),
  };
};

export const buildSupportTicketNotification = (ticket) => {
  const subject = present(ticket?.subject, "Website support request");
  const reference = present(ticket?.reference ?? String(ticket?.id || "").slice(0, 8).toUpperCase(), "unknown");
  const environment = ticket?.environment || {};
  const device = [environment.deviceType, environment.browser, environment.platform].filter(Boolean).join(" · ");
  const viewport = environment.viewport?.width && environment.viewport?.height
    ? `${environment.viewport.width} × ${environment.viewport.height}${environment.devicePixelRatio ? ` at ${environment.devicePixelRatio}×` : ""}`
    : "Not provided";
  const message = renderNotification({
    eyebrow: "Internal notification",
    title: "New website support ticket",
    rows: [
      ["Reference", reference],
      ["Subject", subject],
      ["Reporter", ticket?.contact?.name],
      ["Email", ticket?.contact?.email],
      ["Phone", ticket?.contact?.phone],
      ["Reported page", ticket?.pagePath],
      ["Device", device],
      ["Viewport", viewport],
      ["Submitted", formatDateTime(ticket?.createdAt ?? new Date())],
      ["Open inbox", "https://www.bulgariansociety.nl/user/dashboard/support"],
    ],
  });
  return { ...message, subject: `New support ticket #${reference} — ${subject}`, type: "support-ticket-created", entityId: present(ticket?.id, reference) };
};

export const buildAccessRequestNotification = (request) => ({
  ...renderNotification({
    eyebrow: "Internal notification",
    title: "Administration access requested",
    rows: [
      ["Account ID", request.accountId],
      ["Email", request.email],
      ["Requested access", request.accesses.join(", ")],
      ["Submitted", formatDateTime(request.createdAt)],
    ],
  }),
  subject: "Administration access requested",
  type: "administration-access-request",
  entityId: request.id,
});

export const createInternalNotificationService = ({
  config = getInternalNotificationConfig(),
  sendEmail = sendInternalNotificationEmail,
} = {}) => {
  const queue = (notification) => {
    if (!config.enabled || config.subscribers.length === 0) return 0;

    for (const receiver of config.subscribers) {
      sendEmail({ receiver, ...notification });
    }

    return config.subscribers.length;
  };

  return {
    notifyAccessRequested(request) {
      return queue(buildAccessRequestNotification(request));
    },
    notifyInternshipApplicationCreated(application) {
      return queue(buildInternshipApplicationNotification(application));
    },
    notifyEventCreated(event) {
      return queue(buildEventCreatedNotification(event));
    },
    notifySupportTicketCreated(ticket) {
      return queue(buildSupportTicketNotification(ticket));
    },
  };
};

export const createSupportTicketNotifier = (options = {}) => {
  const service = createInternalNotificationService(options);
  return (ticket) => service.notifySupportTicketCreated(ticket);
};

const internalNotificationService = createInternalNotificationService();

export const notifyInternshipApplicationCreated = (application) => {
  try {
    return internalNotificationService.notifyInternshipApplicationCreated(application);
  } catch (error) {
    console.error("Failed to enqueue internship application notification:", error);
    return 0;
  }
};

export const notifyEventCreated = (event) => {
  try {
    return internalNotificationService.notifyEventCreated(event);
  } catch (error) {
    console.error("Failed to enqueue event notification:", error);
    return 0;
  }
};

export const notifySupportTicketCreated = (ticket) => {
  try { return internalNotificationService.notifySupportTicketCreated(ticket); }
  catch (error) {
    console.error("Failed to enqueue support ticket notification:", error);
    return 0;
  }
};

export const notifyAccessRequested = (request) => internalNotificationService.notifyAccessRequested(request);
