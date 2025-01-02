import { MailtrapClient } from "mailtrap";
import dotenv from "dotenv";
import { WHATS_APP } from "../../util/config/LINKS.js";
import { GUEST_TICKET_TEMPLATE, MEMBER_TICKET_TEMPLATE, NEW_PASS_TEMPLATE, WELCOME_TEMPLATE, CONTEST_MATERIALS_TEMPLATE, NO_REPLY_EMAIL, NO_REPLY_EMAIL_NAME, MEMBERSHIP_EXPIRED_TEMPLATE } from "../../util/config/defines.js";
import moment from "moment";
import { MOMENT_DATE_TIME } from "../../util/functions/dateConvert.js";
dotenv.config();

const client = new MailtrapClient({ endpoint: process.env.MAIL_ENDPOINT, token: process.env.MAIL_TOKEN });

const sender = {
  email: NO_REPLY_EMAIL,
  name: NO_REPLY_EMAIL_NAME,
};

const sendTicketEmail = async (
  type,
  receiver,
  eventName,
  eventDate,
  guestName,
  ticket
) => {
  const recipients = [
    {
      email: receiver,
    },
  ];

  const template_uuid = type === "member" ?
    MEMBER_TICKET_TEMPLATE
    : GUEST_TICKET_TEMPLATE;

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
};

const sendNewPasswordEmail = async (receiver, resetToken) => {
  const recipients = [
    {
      email: receiver,
    },
  ];

  await client
    .send({
      from: sender,
      to: recipients,
      template_uuid: NEW_PASS_TEMPLATE,
      template_variables: {
        template_variables: {
          resetToken,
        },
      },
    })
};

const welcomeEmail = async (receiver, name, region = '') => {
  const recipients = [
    {
      email: receiver,
    },
  ];

  await client
    .send({
      from: sender,
      to: recipients,
      template_uuid: WELCOME_TEMPLATE,
      template_variables: {
        template_variables: {
          name,
          link: (region && WHATS_APP[region]) ?? null
        },
      },
    })
};

const sendContestMaterials = async (receiver) => {
  const recipients = [
    {
      email: receiver,
    },
  ];

  await client
    .send({
      from: sender,
      to: recipients,
      template_uuid: CONTEST_MATERIALS_TEMPLATE,
      template_variables: {
        template_variables: {
        },
      },
    })
};

const paymentFailedEmail = async (receiver, link) => {
  const recipients = [
    {
      email: receiver,
    },
  ];

  await client
    .send({
      from: sender,
      to: recipients,
      template_uuid: MEMBERSHIP_EXPIRED_TEMPLATE,
      template_variables: {
        template_variables: {
          link,
        },
      },
    })
};

export const sendMarketingEmail = async (templateId, receiver, name = '') => {
   const recipients = [
    {
      email: receiver,
    },
  ];

  await client
    .send({
      from: sender,
      to: recipients,
      template_uuid: templateId,
      template_variables: {
        template_variables: {
          name,
        },
      },
    })
}

export { sendTicketEmail, sendNewPasswordEmail, welcomeEmail, sendContestMaterials, paymentFailedEmail };
