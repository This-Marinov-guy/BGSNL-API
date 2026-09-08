import { sendEmail, useDomakinMailer, resolveDomakinResendTemplate } from "./email-provider.js";
import { queueDomakinTemplateEmail } from "./domakin-mailer.js";
import { Resend } from "resend";
import dotenv from "dotenv";
import { WHATS_APP } from "../../util/config/LINKS.js";
import { GUEST_TICKET_TEMPLATE, MEMBER_TICKET_TEMPLATE, NEW_PASS_TEMPLATE, WELCOME_TEMPLATE, CONTEST_MATERIALS_TEMPLATE, NO_REPLY_EMAIL, NO_REPLY_EMAIL_NAME, MEMBERSHIP_EXPIRED_TEMPLATE, ALUMNI_TEMPLATE } from "../../util/config/defines.js";
import moment from "moment-timezone";
import { MOMENT_DATE_TIME } from "../../util/functions/dateConvert.js";
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
    try {
      await Promise.race([
        next.jobFn(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Mail delivery timed out")), MAIL_TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
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
    console.warn(`Mail queue full, dropping oldest job: ${dropped?.key}`);
  }
  activeMailKeys.push(key);
  mailQueue.push({ key, jobFn });
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

const sendTicketEmail = (
  type,
  receiver,
  eventName,
  eventDate,
  guestName,
  tickets,
  timezone = "Europe/Amsterdam"
) => {
  enqueueMail(`ticket:${type}:${receiver}:${eventName}:${eventDate}`, async () => {
    const recipients = [
      { email: receiver },
    ];
    const template_uuid = type === "member" ? MEMBER_TICKET_TEMPLATE : GUEST_TICKET_TEMPLATE;

    await client.send({
      from: sender,
      to: recipients,
      template_uuid,
      template_variables: {
        template_variables: {
          eventName,
          eventDate: `${moment(eventDate)
            .tz(timezone)
            .format(MOMENT_DATE_TIME)} (${timezone} time)`,
          guestName,
          tickets: Array.isArray(tickets) ? tickets : [tickets],
        },
      },
    });
  });
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

    if (response?.error) {
      throw new Error(response.error.message || "Resend email failed");
    }
  });
};

export const sendInternalNotificationEmail = ({
  receiver,
  subject,
  text,
  html,
  type,
  entityId,
}) => {
  const key = `internal:${type}:${entityId}:${receiver}`;

  enqueueMail(key, async () => {
    await client.send({
      from: sender,
      to: [{ email: receiver }],
      subject,
      text,
      html,
      category: "internal-notification",
      custom_variables: {
        notification_type: type,
        entity_id: String(entityId),
      },
    });
  });
};

const escapeEmailHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

export const buildEventDraftReminderEmail = ({ eventTitle, continueUrl }) => {
  const title =
    String(eventTitle || "Untitled event").replace(/[\r\n]+/g, " ").trim() ||
    "Untitled event";
  const safeTitle = escapeEmailHtml(title);
  const safeContinueUrl = escapeEmailHtml(continueUrl);

  return {
    subject: `Continue your event draft — ${title}`,
    text: [
      `Your event draft “${title}” is saved and ready to continue.`,
      "",
      `Continue editing: ${continueUrl}`,
      "",
      "Sign in with a Bulgarian Society Netherlands team account that has access to this draft.",
    ].join("\n"),
    html: `<!doctype html>
      <html lang="en">
        <body style="margin:0;padding:24px;background:#f3f6f4;font-family:Arial,sans-serif;color:#17201c;">
          <div style="max-width:600px;margin:0 auto;padding:32px;border-radius:16px;background:#ffffff;box-shadow:0 16px 44px rgba(32,60,49,.10);">
            <h1 style="margin:0 0 12px;font-size:26px;line-height:1.2;">Continue your event draft</h1>
            <p style="margin:0 0 24px;font-size:16px;line-height:1.55;">Your draft <strong>${safeTitle}</strong> is saved and ready when you are.</p>
            <a href="${safeContinueUrl}" style="display:inline-block;padding:13px 20px;border-radius:10px;background:#017363;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;">Continue editing</a>
            <p style="margin:24px 0 0;color:#66716b;font-size:14px;line-height:1.5;">Sign in with a Bulgarian Society Netherlands team account that has access to this draft.</p>
          </div>
        </body>
      </html>`,
  };
};

export const sendEventDraftReminderEmail = ({
  receiver,
  eventId,
  eventTitle,
  continueUrl,
}) => {
  const message = buildEventDraftReminderEmail({ eventTitle, continueUrl });

  enqueueMail(`event-draft-reminder:${eventId}:${receiver}`, async () => {
    await client.send({
      from: sender,
      to: [{ email: receiver }],
      ...message,
      category: "event-draft-reminder",
      custom_variables: {
        event_draft_id: String(eventId),
      },
    });
  });
};

export { sendTicketEmail, sendNewPasswordEmail, welcomeEmail, sendContestMaterials, paymentFailedEmail };
