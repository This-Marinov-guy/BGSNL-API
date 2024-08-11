import { MailtrapClient } from "mailtrap";
import dotenv from "dotenv";
import { WHATS_APP } from "../util/config/LINKS.js";
import { GUEST_TICKET_TEMPLATE, MEMBER_TICKET_TEMPLATE, NEW_PASS_TEMPLATE, WELCOME_TEMPLATE, CONTEST_MATERIALS_TEMPLATE, NO_REPLY_EMAIL, NO_REPLY_EMAIL_NAME } from "../util/config/defines.js";
dotenv.config();

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
  const recipients = [
    {
      email: receiver,
    },
  ];

  const template_uuid = type === "member" ?
    MEMBER_TICKET_TEMPLATE
    : GUEST_TICKET_TEMPLATE;

  client
    .send({
      from: sender,
      to: recipients,
      template_uuid,
      template_variables: {
        template_variables: {
          eventName,
          eventDate,
          guestName,
          ticket,
        },
      },
    })
    .then(console.log, console.error);
};

const sendNewPasswordEmail = async (receiver, resetToken) => {
  const recipients = [
    {
      email: receiver,
    },
  ];

  client
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
    .then(console.log, console.error);
};

const welcomeEmail = async (receiver, name, region = '') => {
  const recipients = [
    {
      email: receiver,
    },
  ];

  client
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
    .then(console.log, console.error);
};

const sendContestMaterials = async (receiver) => {
  const recipients = [
    {
      email: receiver,
    },
  ];

  client
    .send({
      from: sender,
      to: recipients,
      template_uuid: CONTEST_MATERIALS_TEMPLATE,
      template_variables: {
        template_variables: {
        },
      },
    })
    .then(console.log, console.error);
};

export { sendTicketEmail, sendNewPasswordEmail, welcomeEmail, sendContestMaterials };
