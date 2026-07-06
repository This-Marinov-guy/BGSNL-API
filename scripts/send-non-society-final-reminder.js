import dotenv from "dotenv";
dotenv.config();

import { MailtrapClient } from "mailtrap";
import mongoose from "mongoose";
import NonSocietyEvent from "../models/NonSocietyEvent.js";
import {
  NON_SOCIETY_EVENT_FINAL_REMINDER_EVENT_ID,
  NON_SOCIETY_EVENT_FINAL_REMINDER_TEMPLATE,
  NON_SOCIETY_EVENT_FINAL_REMINDER_TEST_EMAILS,
  NO_REPLY_EMAIL,
  NO_REPLY_EMAIL_NAME,
} from "../util/config/defines.js";
import moment from "moment-timezone";
import { MOMENT_DATE_TIME_YEAR } from "../util/functions/dateConvert.js";

mongoose.set("strictQuery", true);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const args = new Set(process.argv.slice(2));
const sendAll = args.has("--all");
const dryRun = args.has("--dry-run");
const useSampleVariables = args.has("--sample-vars");
const client = new MailtrapClient({
  endpoint: process.env.MAIL_ENDPOINT,
  token: process.env.MAIL_TOKEN,
});

const sampleTemplateVariables = {
  template_variables: {
    eventName: "Test_Template_variables_Eventname",
    guestName: "Test_Template_variables_Guestname",
    eventDate: "Test_Template_variables_Eventdate",
  },
};

const getMongoUri = () =>
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;

const formatEventDate = (date, timezone = "Europe/Amsterdam") => {
  if (!date) return "";

  return `${moment(date)
    .tz(timezone)
    .format(MOMENT_DATE_TIME_YEAR)} (${timezone} time)`;
};

const addRecipient = (recipientsByEmail, invalidEmails, email, name = "") => {
  const normalizedEmail = String(email || "").trim().toLowerCase();

  if (!normalizedEmail) return;

  if (!EMAIL_REGEX.test(normalizedEmail)) {
    invalidEmails.push(email);
    return;
  }

  if (!recipientsByEmail.has(normalizedEmail)) {
    recipientsByEmail.set(normalizedEmail, {
      email: normalizedEmail,
      name: String(name || "").trim(),
    });
  }
};

const getEvent = async () => {
  await mongoose.connect(getMongoUri());

  const event = await NonSocietyEvent.findById(
    NON_SOCIETY_EVENT_FINAL_REMINDER_EVENT_ID
  ).select("event date timezone guestList.email guestList.name");

  if (!event) {
    throw new Error(
      `Non-society event not found: ${NON_SOCIETY_EVENT_FINAL_REMINDER_EVENT_ID}`
    );
  }

  return event;
};

const buildRecipients = (event) => {
  const recipientsByEmail = new Map();
  const invalidEmails = [];

  if (sendAll) {
    for (const guest of event.guestList || []) {
      addRecipient(recipientsByEmail, invalidEmails, guest.email, guest.name);
    }
  } else {
    for (const email of NON_SOCIETY_EVENT_FINAL_REMINDER_TEST_EMAILS) {
      addRecipient(
        recipientsByEmail,
        invalidEmails,
        email,
        "Vladislav Marinov"
      );
    }
  }

  return {
    recipients: [...recipientsByEmail.values()],
    invalidEmails,
  };
};

const sendReminder = async (recipient, templateVariables) => {
  return client.send({
    from: {
      email: NO_REPLY_EMAIL,
      name: NO_REPLY_EMAIL_NAME,
    },
    to: [{ email: recipient.email }],
    template_uuid: NON_SOCIETY_EVENT_FINAL_REMINDER_TEMPLATE,
    template_variables: templateVariables,
  });
};

try {
  let event = null;

  if (sendAll || !useSampleVariables) {
    event = await getEvent();
  }

  const { recipients, invalidEmails } = buildRecipients(event);

  console.log(
    `Final reminder ${dryRun ? "dry run" : "send"} | mode=${sendAll ? "all" : "test"} | recipients=${recipients.length}`
  );

  if (invalidEmails.length > 0) {
    console.log(`Invalid emails skipped: ${invalidEmails.join(", ")}`);
  }

  if (dryRun) {
    for (const recipient of recipients) {
      console.log(`${recipient.email}${recipient.name ? ` | ${recipient.name}` : ""}`);
    }
  } else {
    for (const recipient of recipients) {
      const templateVariables = useSampleVariables
        ? sampleTemplateVariables
        : {
            template_variables: {
              eventName: event.event,
              guestName: recipient.name,
              eventDate: formatEventDate(event.date, event.timezone),
            },
          };

      const response = await sendReminder(recipient, templateVariables);

      if (response?.message_ids?.length) {
        console.log(`${recipient.email} | ${response.message_ids.join(", ")}`);
      } else {
        console.log(`${recipient.email} | sent`);
      }
    }
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
