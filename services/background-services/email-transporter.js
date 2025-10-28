import { MailtrapClient } from "mailtrap";
import dotenv from "dotenv";
import { WHATS_APP } from "../../util/config/LINKS.js";
import { GUEST_TICKET_TEMPLATE, MEMBER_TICKET_TEMPLATE, NEW_PASS_TEMPLATE, WELCOME_TEMPLATE, CONTEST_MATERIALS_TEMPLATE, NO_REPLY_EMAIL, NO_REPLY_EMAIL_NAME, MEMBERSHIP_EXPIRED_TEMPLATE, ALUMNI_TEMPLATE } from "../../util/config/defines.js";
import moment from "moment";
import { MOMENT_DATE_TIME } from "../../util/functions/dateConvert.js";
dotenv.config();

// Lightweight background mail queue with concurrency limit and de-duplication
const MAIL_MAX_CONCURRENCY = 2;
const MAIL_MAX_QUEUE = 500;
const MAIL_TIMEOUT_MS = 60000; // 60s per job
const mailQueue = [];
const activeMailKeys = [];
let activeMailCount = 0;

function processMailQueue() {
  if (activeMailCount >= MAIL_MAX_CONCURRENCY) return;
  const next = mailQueue.shift();
  if (!next) return;
  activeMailCount++;
  (async () => {
    try {
      await Promise.race([
        next.jobFn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Mail timeout: ${next.key}`)), MAIL_TIMEOUT_MS)
        ),
      ]);
    } catch (e) {
      console.error("Background mail error:", e);
    } finally {
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

const client = new MailtrapClient({ endpoint: process.env.MAIL_ENDPOINT, token: process.env.MAIL_TOKEN });

const sender = {
  email: NO_REPLY_EMAIL,
  name: NO_REPLY_EMAIL_NAME,
};

const sendTicketEmail = (
  type,
  receiver,
  eventName,
  eventDate,
  guestName,
  ticket
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
            .tz("Europe/Amsterdam")
            .format(MOMENT_DATE_TIME)} (Amsterdam/Europe time)`,
          guestName,
          ticket,
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
}

export { sendTicketEmail, sendNewPasswordEmail, welcomeEmail, sendContestMaterials, paymentFailedEmail };
