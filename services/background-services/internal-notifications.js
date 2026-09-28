import { sendInternalNotificationEmail, sendCustomerSupportEmail } from "./email-transporter.js";
import { buildCustomerSupportReplyEmail } from "../support/reply-email.js";
import { getInternalNotificationConfig } from "../../util/config/internal-notifications.js";
import { HOME_URL } from "../../util/config/defines.js";
import { formatRegionBadgeLabel, getRegionBadgeTheme } from "../../util/config/region-badges.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";

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

// Match the BGSNL Mailer content shell (sage canvas, white card, green type),
// without the customer-facing header and footer artwork.
const renderRowValue = (value, options) => {
  const content = escapeHtml(present(value));
  if (options?.region !== undefined) {
    const theme = getRegionBadgeTheme(options.region);
    return `<span style="display:inline-block;padding:5px 10px;border:1px solid ${theme.border};border-radius:999px;background-color:${theme.background};color:${theme.color};font-size:14px;font-weight:700;line-height:1.4;">${content}</span>`;
  }
  if (options?.href) {
    return `<a href="${escapeHtml(options.href)}" style="color:#017363;font-weight:700;text-decoration:underline;overflow-wrap:anywhere;">View event</a>`;
  }
  return content.replaceAll("\n", "<br>");
};

const renderNotification = ({ title, rows }) => {
  const textRows = rows.map(([label, value]) => `${label}: ${present(value)}`);
  const htmlRows = rows
    .map(
      ([label, value, options]) => `
        <tr>
          <th scope="row" class="notification-label" style="width:32%;padding:12px 16px 12px 0;color:#647067;font-family:Arial,sans-serif;font-size:14px;font-weight:400;line-height:1.6;text-align:left;vertical-align:top;">${escapeHtml(label)}</th>
          <td class="notification-value" style="padding:12px 0;color:#33403a;font-family:Arial,sans-serif;font-size:16px;line-height:1.6;vertical-align:top;overflow-wrap:anywhere;word-break:break-word;">${renderRowValue(value, options)}</td>
        </tr>`
    )
    .join("");

  return {
    text: ["Internal notification", title, "", ...textRows].join("\n"),
    html: `<!doctype html>
      <html lang="en">
        <head>
          <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${escapeHtml(title)}</title>
          <style>
            body, table, td, th { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
            table, td, th { mso-table-lspace:0pt; mso-table-rspace:0pt; }
            @media screen and (max-width:620px) {
              .notification-container { width:100% !important; }
              .notification-content { padding:28px 20px !important; }
            }
            @media screen and (max-width:440px) {
              .notification-label { display:block !important; width:auto !important; padding:12px 0 2px !important; }
              .notification-value { display:block !important; width:auto !important; padding:0 0 12px !important; }
            }
          </style>
        </head>
        <body style="margin:0;padding:0;background-color:#bcd2bf;font-family:Arial,sans-serif;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#bcd2bf" style="background-color:#bcd2bf;">
            <tr><td align="center" style="padding:28px 12px;">
              <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
              <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" class="notification-container" bgcolor="#ffffff" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:16px;overflow:hidden;">
                <tr><td class="notification-content" style="padding:36px 40px;font-family:Arial,sans-serif;">
                  <h1 style="margin:0 0 20px;color:#173f35;font-family:Arial,sans-serif;font-size:24px;line-height:1.3;font-weight:700;">${escapeHtml(title)}</h1>
                  <table aria-label="Notification details" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;table-layout:fixed;border-collapse:collapse;">${htmlRows}</table>
                </td></tr>
              </table>
              <!--[if mso]></td></tr></table><![endif]-->
            </td></tr>
          </table>
        </body>
      </html>`,
  };
};

export const buildInternshipApplicationNotification = (application) => {
  const position = present(application?.position, "Unspecified position");
  const message = renderNotification({
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

const formatTicketPrice = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return "Not set";
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return "Not set";
  return amount === 0 ? "Free" : new Intl.NumberFormat("en-NL", { style: "currency", currency: "EUR" }).format(amount);
};

const eventPrices = (event) => {
  if (event?.isFree) return "Free";
  if (event?.ticketLink) return "See external ticket provider";
  const product = event?.product;
  return [
    !event?.memberOnly && `Guest: ${formatTicketPrice(product?.guest?.price)}`,
    `Member: ${event?.isMemberFree ? "Free" : formatTicketPrice(product?.member?.price)}`,
    `Active member: ${event?.isMemberFree ? "Free" : formatTicketPrice(product?.activeMember?.price ?? product?.member?.price)}`,
  ].filter(Boolean).join("\n");
};

export const buildEventCreatedNotification = (event) => {
  const title = present(event?.title, "Untitled event");
  const region = String(event?.region ?? "").trim().toLowerCase();
  const identifier = event?.slug || event?.id || event?._id;
  const link = region && identifier
    ? `${HOME_URL}/${encodeURIComponent(region)}/event-details/${encodeURIComponent(identifier)}`
    : null;
  const message = renderNotification({
    title: "New event added",
    rows: [
      ["Title", title],
      ["Region", formatRegionBadgeLabel(region), { region }],
      ["Date & time", formatDateTime(event?.date)],
      ["Location", event?.location],
      ["Prices", eventPrices(event)],
      ["Link", link, { href: link }],
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
    title: ticket?.type === "recommendation" ? "New recommendation" : "New website support ticket",
    rows: [
      ["Reference", reference],
      ["Type", ticket?.type === "recommendation" ? "Recommendation" : "Problem report"],
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
  return { ...message, subject: `${ticket?.type === "recommendation" ? "New recommendation" : "New support ticket"} #${reference} — ${subject}`, type: "support-ticket-created", entityId: present(ticket?.id, reference) };
};

export const buildAccessRequestNotification = (request) => ({
  ...renderNotification({
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

export const buildSupportReplyNotification = (ticket, reply) => ({
  ...renderNotification({
    title: reply.reopened ? "Support ticket reopened" : "New support ticket reply",
    rows: [
      ["Reference", ticket.reference || ticket.id],
      ["Subject", ticket.subject],
      ["Status", ticket.status],
      ["Reply from", reply.author === "staff" ? "Support team" : "Requester"],
      ["Reporter", ticket.contact?.name],
      ["Message", reply.text || "Photo attachment"],
      ["Attachments", String(reply.attachments?.length || 0)],
      ["Replied", formatDateTime(reply.createdAt)],
      ["Open inbox", `${HOME_URL}/user/dashboard/support`],
    ],
  }),
  subject: `${reply.reopened ? "Support ticket reopened" : "New support reply"} #${ticket.reference || ticket.id} — ${present(ticket.subject)}`,
  type: "support-ticket-replied",
  entityId: `${ticket.id}:${reply.id}`,
});

export const createInternalNotificationService = ({
  config = getInternalNotificationConfig(),
  sendEmail = sendInternalNotificationEmail,
  sendCustomerEmail = sendCustomerSupportEmail,
} = {}) => {
  const queue = (notification) => {
    if (!config.enabled || config.subscribers.length === 0) return 0;

    for (const receiver of config.subscribers) {
      sendEmail({ receiver, ...notification });
    }

    return config.subscribers.length;
  };

  return {
    notifySupportTicketReplied(ticket, reply) {
      let queued = 0;
      // Customer mail is transactional, independent of internal subscriptions.
      if (reply.author === "staff" && ticket.contact?.email) {
        sendCustomerEmail(buildCustomerSupportReplyEmail(ticket, reply));
        queued++;
      }
      return queued + queue(buildSupportReplyNotification(ticket, reply));
    },
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
    logOperationalError("service.internship-notification", error);
    console.error("Failed to enqueue internship application notification:", error);
    return 0;
  }
};

export const notifyEventCreated = (event) => {
  try {
    return internalNotificationService.notifyEventCreated(event);
  } catch (error) {
    logOperationalError("service.event-notification", error);
    console.error("Failed to enqueue event notification:", error);
    return 0;
  }
};

export const notifySupportTicketCreated = (ticket) => {
  try { return internalNotificationService.notifySupportTicketCreated(ticket); }
  catch (error) {
    logOperationalError("service.support-notification", error);
    console.error("Failed to enqueue support ticket notification:", error);
    return 0;
  }
};

export const notifyAccessRequested = (request) => internalNotificationService.notifyAccessRequested(request);
export const notifySupportTicketReplied = (ticket, reply) => internalNotificationService.notifySupportTicketReplied(ticket, reply);
