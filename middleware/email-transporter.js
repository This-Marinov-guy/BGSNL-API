import { MailtrapClient } from "mailtrap";
import dotenv from "dotenv";
dotenv.config();

const client = new MailtrapClient({ endpoint: process.env.MAIL_ENDPOINT, token: process.env.MAIL_TOKEN });

const sender = {
  email: "bulgariansociety.rtm@vladislavmarinov.com",
  name: "Bulgarian Society Rotterdam",
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

  let template_uuid;
  if (type === "member") {
    template_uuid = "a0f1f0f4-d313-4642-bf0b-1f568cc705dd";
  } else if (type === "guest") {
    template_uuid = "17d8d728-4a7b-4c02-a8fb-bc56b32516f2";
  }

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
      template_uuid: "824f447b-0ca1-4dcf-9c10-223d71cf48eb",
      template_variables: {
        template_variables: {
          resetToken,
        },
      },
    })
    .then(console.log, console.error);
};

const welcomeEmail = async (receiver, name) => {
  const recipients = [
    {
      email: receiver,
    },
  ];

  client
    .send({
      from: sender,
      to: recipients,
      template_uuid: "fd5dba3e-221b-4997-b6e8-987a1740bc0e",
      template_variables: {
        template_variables: {
          name,
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
      template_uuid: "c130f73a-17f7-4fe8-be84-4acf9d5d2800",
      template_variables: {
        template_variables: {
        },
      },
    })
    .then(console.log, console.error);
};

export { sendTicketEmail, sendNewPasswordEmail, welcomeEmail, sendContestMaterials };
