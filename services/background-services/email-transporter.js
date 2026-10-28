import { sendEmail, useDomakinMailer, resolveDomakinResendTemplate } from "./email-provider.js";
import { queueDomakinTemplateEmail, stableMailerOperationId } from "./domakin-mailer.js";
import { logIntegrationError, logIntegrationRequest, logOperationalError } from "../../middleware/axiom-logger.js";
import { jobNameFromKey, observeJob } from "../monitoring/job-history.js";
import { Resend } from "resend";
import dotenv from "dotenv";
import { WHATS_APP } from "../../util/config/LINKS.js";
import { NEW_PASS_TEMPLATE, WELCOME_TEMPLATE, CONTEST_MATERIALS_TEMPLATE, NO_REPLY_EMAIL, NO_REPLY_EMAIL_NAME, MEMBERSHIP_EXPIRED_TEMPLATE, ALUMNI_TEMPLATE, EVENT_DRAFT_REMINDER_TEMPLATE, REGIONS } from "../../util/config/defines.js";
import { createGuestSignupLink } from "../events/guest-signup-prefill.js";
import { formatRegionBadgeLabel, getRegionBadgeTheme } from "../../util/config/region-badges.js";
import moment from "moment-timezone";
import { buildTicketEmailContent } from "../events/ticket-email-content.js";
export { queueDomakinTemplateEmail } from "./domakin-mailer.js";
dotenv.config();

// Lightweight background mail queue with concurrency limit and de-duplication
const MAIL_MAX_CONCURRENCY = 2;
const MAIL_MAX_QUEUE = 500;
const MAIL_TIMEOUT_MS = useDomakinMailer() ? 100000 : 60000; // Domakin HTTP acceptance allows 95s.
const mailQueue = [];
const activeMailKeys = [];
let activeMailCount = 0;

function processMailQueue() {
  if (activeMailCount >= MAIL_MAX_CONCURRENCY) return;
  const next = mailQueue.shift();
  if (!next) return;
  activeMailCount++;
  (async () => {
    let timeout;
    next.record.start();
    try {
      await Promise.race([
        next.jobFn(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Mail delivery timed out")), MAIL_TIMEOUT_MS);
        }),
      ]);
      next.record.complete();
    } catch (e) {
      next.record.fail(e);
      logIntegrationError(useDomakinMailer() ? "mailer" : "email-provider", e, "delivery");
      // Axios errors contain authorization headers, reset tokens and email
      // bodies. Never log the request/config object or recipient queue key.
      console.error("Background mail failed", { code: e.code, status: e.response?.status,
        ...(!e.isAxiosError ? { message: e.message } : {}),
      });
    } finally {
      clearTimeout(timeout);
      const idx = activeMailKeys.indexOf(next.key);
      if (idx !== -1) activeMailKeys.splice(idx, 1);
      activeMailCount--;
      setImmediate(processMailQueue);
    }
  })();
}

function enqueueMail(key, jobFn) {
  if (mailQueue.length >= MAIL_MAX_QUEUE) {
    const dropped = mailQueue.shift();
    dropped.record.fail(new Error("Mail queue full"));
    const index = activeMailKeys.indexOf(dropped.key);
    if (index !== -1) activeMailKeys.splice(index, 1);
    console.warn("Mail queue full, dropping oldest job");
    logOperationalError("mailer.queue", new Error("Queue full"));
  }
  activeMailKeys.push(key);
  mailQueue.push({ key, jobFn, record: observeJob("mailer", jobNameFromKey(key)) });
  processMailQueue();
}

const client = { send: sendEmail };
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const sender = {
  email: NO_REPLY_EMAIL,
  name: NO_REPLY_EMAIL_NAME,
};

const resendSender = `${NO_REPLY_EMAIL_NAME} <${NO_REPLY_EMAIL}>`;

const safePosterUrl = value => {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
};

export const buildGuestTicketSignupUrl = ({ email, name, phone = "", region }, options) => {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!REGIONS.includes(region) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return "";
  const [firstName = "", ...surname] = String(name || "").trim().split(/\s+/).filter(Boolean);
  const safePhone = /^\+?[\d\s()-]{8,40}$/.test(String(phone || "")) ? String(phone).trim() : "";
  return createGuestSignupLink({ email: normalizedEmail, region, name: firstName,
    surname: surname.join(" "), phone: safePhone }, options);
};

export const buildTicketTemplateVariables = ({ eventName, eventDate, guestName, tickets,
  timezone = "Europe/Amsterdam", poster = "", signupUrl = "", walletUrl = "" }) => {
  const ticketImages = Array.isArray(tickets) ? tickets : [tickets];
  return { template_variables: {
    eventName,
    eventDate: moment(eventDate).tz(timezone).format("DD.MM | HH:mm"),
    guestName,
    tickets: ticketImages,
    ticketUrl: ticketImages[0] || "",
    poster: safePosterUrl(poster),
    signupUrl,
    walletUrl,
  } };
};

const sendTicketEmail = (
  type,
  receiver,
  eventName,
  eventDate,
  guestName,
  tickets,
  timezone = "Europe/Amsterdam",
  poster = "",
  guestDetails = {},
  walletUrl = ""
) => {
  let signupUrl = "";
  if (type === "guest" && guestDetails.region) {
    try {
      signupUrl = buildGuestTicketSignupUrl({ email: receiver, name: guestName,
        phone: guestDetails.phone, region: guestDetails.region });
    } catch (error) {
      logOperationalError("guest-ticket.signup-prefill", error);
    }
  }
  enqueueMail(`ticket:${type}:${receiver}:${eventName}:${eventDate}`, async () => {
    const recipients = [
      { email: receiver },
    ];
    const variables = buildTicketTemplateVariables({ eventName, eventDate, guestName,
      tickets, timezone, poster, signupUrl, walletUrl }).template_variables;
    await client.send({
      from: sender,
      to: recipients,
      ...buildTicketEmailContent(variables),
    });
  });
};

// Manual sends wait for provider acceptance so the guest-list UI can report a
// real result instead of treating a queued background job as delivered.
export const sendTicketEmailNow = async ({ type, receiver, eventName, eventDate,
  guestName, tickets, timezone = "Europe/Amsterdam", poster = "", guestDetails = {}, walletUrl = "" }) => {
  let signupUrl = "";
  if (type === "guest" && guestDetails.region) {
    try {
      signupUrl = buildGuestTicketSignupUrl({ email: receiver, name: guestName,
        phone: guestDetails.phone, region: guestDetails.region });
    } catch (error) {
      logOperationalError("guest-ticket.signup-prefill", error);
    }
  }
  const variables = buildTicketTemplateVariables({ eventName, eventDate, guestName,
    tickets, timezone, poster, signupUrl, walletUrl }).template_variables;
  return client.send({ from: sender, to: [{ email: receiver }],
    ...buildTicketEmailContent(variables) });
};

const sendNewPasswordEmail = (receiver, resetToken) => {
  enqueueMail(`newpass:${receiver}`, async () => {
    const recipients = [{ email: receiver }];
    await client.send({
      from: sender,
      to: recipients,
      template_uuid: NEW_PASS_TEMPLATE,
      template_variables: { template_variables: { resetToken } },
    });
  });
};

const welcomeEmail = (receiver, name, region = '') => {
  enqueueMail(`welcome:${receiver}`, async () => {
    const recipients = [{ email: receiver }];
    await client.send({
      from: sender,
      to: recipients,
      template_uuid: WELCOME_TEMPLATE,
      template_variables: {
        template_variables: {
          name,
          link: (region && WHATS_APP[region]) ?? null,
        },
      },
    });
  });
};

export const alumniWelcomeEmail = (receiver, name) => {
  enqueueMail(`alumni:${receiver}`, async () => {
    const recipients = [{ email: receiver }];
    await client.send({
      from: sender,
      to: recipients,
      template_uuid: ALUMNI_TEMPLATE,
      template_variables: {
        template_variables: {
          name,
          link: WHATS_APP['alumni'],
        },
      },
    });
  });
};

const sendContestMaterials = (receiver) => {
  enqueueMail(`contest:${receiver}`, async () => {
    const recipients = [{ email: receiver }];
    await client.send({
      from: sender,
      to: recipients,
      template_uuid: CONTEST_MATERIALS_TEMPLATE,
      template_variables: { template_variables: {} },
    });
  });
};

const paymentFailedEmail = (receiver, link) => {
  enqueueMail(`expired:${receiver}`, async () => {
    const recipients = [{ email: receiver }];
    await client.send({
      from: sender,
      to: recipients,
      template_uuid: MEMBERSHIP_EXPIRED_TEMPLATE,
      template_variables: { template_variables: { link } },
    });
  });
};

export const sendMarketingEmail = (templateId, receiver, name = '') => {
  enqueueMail(`marketing:${templateId}:${receiver}`, async () => {
    const recipients = [{ email: receiver }];
    await client.send({
      from: sender,
      to: recipients,
      template_uuid: templateId,
      template_variables: { template_variables: { name } },
    });
  });
};

export const sendMailtrapTemplateEmail = (
  templateId,
  receiver,
  templateVariables = {}
) => {
  enqueueMail(`mailtrap-template:${templateId}:${receiver}`, async () => {
    const recipients = [{ email: receiver }];

    await client.send({
      from: sender,
      to: recipients,
      template_uuid: templateId,
      template_variables: templateVariables,
    });
  });
};

export const sendResendTemplateEmail = (
  templateId,
  receiver,
  name = '',
  variables = {}
) => {
  enqueueMail(`resend-template:${templateId}:${receiver}`, async () => {
    if (useDomakinMailer()) {
      const values = { ...variables };
      delete values.subject;
      const templateVariables = { name, ...values };
      await queueDomakinTemplateEmail(resolveDomakinResendTemplate(templateId), receiver, {
        ...templateVariables, template_variables: templateVariables,
      });
      return;
    }
    if (!resend) {
      throw new Error("Missing RESEND_API_KEY");
    }

    const {
      subject = "Bulgarian Society Netherlands",
      ...templateVariables
    } = variables;

    const started = Date.now();
    try {
      const response = await resend.emails.send({
        from: resendSender,
        to: receiver,
        subject,
        template: {
          id: templateId,
          variables: {
            name,
            ...templateVariables,
          },
        },
      });
      if (response?.error) throw new Error(response.error.message || "Resend email failed");
      logIntegrationRequest("resend", "send-email", { method: "POST", durationMs: Date.now() - started });
    } catch (error) {
      logIntegrationRequest("resend", "send-email", { method: "POST", outcome: "error",
        status: error?.statusCode || error?.status, durationMs: Date.now() - started });
      throw error;
    }
  });
};

export const deliverInternalNotificationEmail = async ({
  receiver,
  subject,
  text,
  html,
  type,
  entityId,
  category = "internal-notification",
  operationId,
}) => {
  const delivery = client.send({
    from: sender,
    to: [{ email: receiver }],
    subject,
    text,
    html,
    category,
    custom_variables: {
      notification_type: type,
      entity_id: String(entityId),
    },
    ...(operationId ? { operationId } : {}),
  });
  let timeout;
  try {
    return await Promise.race([
      delivery,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Mail delivery timed out")), MAIL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};

export const sendInternalNotificationEmail = (message) => {
  const { receiver, type, entityId } = message;
  const key = `internal:${type}:${entityId}:${receiver}`;

  enqueueMail(key, async () => {
    await deliverInternalNotificationEmail(message);
  });
};

export const supportReplyOperationId = ({ entityId, receiver }) =>
  stableMailerOperationId("bgsnl-support-reply", entityId, String(receiver).trim().toLowerCase());

export const sendCustomerSupportEmail = (message) => {
  const key = `support-reply:${message.entityId}:${message.receiver}`;
  const operationId = supportReplyOperationId(message);
  enqueueMail(key, () => deliverInternalNotificationEmail({ ...message, category: "support-reply", operationId }));
};

// The branded header/footer shell lives in Domakin Mailer's own
// "event-draft-reminder" template (templates/bulgariansociety/event-draft-reminder--<uuid>.html).
export const buildEventDraftReminderEmail = ({ eventTitle, eventDate, poster, region, continueUrl }) => {
  const title =
    String(eventTitle || "Untitled event").replace(/[\r\n]+/g, " ").trim() ||
    "Untitled event";
  const date = eventDate ? moment(eventDate) : null;
  const badgeTheme = getRegionBadgeTheme(region);

  return {
    templateId: EVENT_DRAFT_REMINDER_TEMPLATE,
    templateVariables: {
      eventTitle: title,
      eventDate: date?.isValid() ? date.tz("Europe/Amsterdam").format("DD.MM | HH:mm") : "",
      poster: safePosterUrl(poster),
      regionLabel: formatRegionBadgeLabel(region),
      regionBadgeBackground: badgeTheme.background,
      regionBadgeBorder: badgeTheme.border,
      regionBadgeColor: badgeTheme.color,
      continueUrl,
    },
  };
};

export const sendEventDraftReminderEmail = ({
  receiver,
  eventId,
  eventTitle,
  eventDate,
  poster,
  region,
  continueUrl,
}) => {
  const { templateId, templateVariables } = buildEventDraftReminderEmail({ eventTitle, eventDate, poster, region, continueUrl });

  enqueueMail(`event-draft-reminder:${eventId}:${receiver}`, async () => {
    await queueDomakinTemplateEmail(templateId, receiver, templateVariables);
  });
};

export { sendTicketEmail, sendNewPasswordEmail, welcomeEmail, sendContestMaterials, paymentFailedEmail };
