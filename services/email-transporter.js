import { MailtrapClient } from "mailtrap";
import dotenv from "dotenv";
import { WHATS_APP } from "../util/config/LINKS.js";
import { GUEST_TICKET_TEMPLATE, MEMBER_TICKET_TEMPLATE, NEW_PASS_TEMPLATE, WELCOME_TEMPLATE, CONTEST_MATERIALS_TEMPLATE, NO_REPLY_EMAIL, NO_REPLY_EMAIL_NAME } from "../util/config/defines.js";
import moment from "moment";
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

  await client
    .send({
      from: sender,
      to: recipients,
      template_uuid,
      template_variables: {
        template_variables: {
          eventName,
          eventDate: moment(eventDate).format("D MMM YYYY, h:mm"),
          guestName,
          ticket,
        },
      },
    })
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

export { sendTicketEmail, sendNewPasswordEmail, welcomeEmail, sendContestMaterials };
