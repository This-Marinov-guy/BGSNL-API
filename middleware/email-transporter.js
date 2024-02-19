import { MailtrapClient } from "mailtrap";
import dotenv from "dotenv";
dotenv.config();

const client = new MailtrapClient({ endpoint: process.env.MAIL_ENDPOINT, token: process.env.MAIL_TOKEN });

const sender = {
  email: "bulgariansociety.lwd@vladislavmarinov.com",
  name: "Bulgarian Society Leeuwarden",
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
    template_uuid = "14f21f95-5da5-44b0-ad05-3aa555fceddc";
  } else if (type === "guest") {
    template_uuid = "744d6b34-98b2-4093-b4ba-6792efc5e628";
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
