import { google } from "googleapis";
import dotenv from "dotenv";
import moment from "moment";
import { IS_PROD } from "../../util/functions/helpers.js";

dotenv.config();

const calendarId = process.env.CALENDAR_ID;

const getCalendarClient = async () => {
  const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_ADMIN_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  const googleClient = await auth.getClient();
  return google.calendar({ version: "v3", auth: googleClient });
};

// function to format the Google Event object
const formatCalendarEvent = (eventData) => {
  const startDateTime = moment(eventData.date, moment.ISO_8601, true);
  if (!startDateTime.isValid()) {
    throw new Error("Invalid date format. Please use ISO 8601.");
  }

  return {
    summary: eventData.title,
    location: eventData.location,
    description: eventData.text, // check if it should be text or description
    start: {
      dateTime: startDateTime.toISOString(),
      timeZone: "Europe/Amsterdam",
    },
    end: {
      dateTime: startDateTime.add(2, "hours").toISOString(),
      timeZone: "Europe/Amsterdam",
    },
  };
};

const handleCalendarOperation = async (operation, params) => {
  const calendar = await getCalendarClient();
  try {
    const response = await operation(calendar, params);
    console.log("Operation successful:", response.data);
    return response.data;
  } catch (error) {
    console.error("Error in calendar operation:", error.response?.data || error);
    throw new Error("Google Calendar API operation failed");
  }
};

export const addOrUpdateEvent = async (eventData) => {
  if (!IS_PROD) {
    return;
  }
  
  if (eventData.hidden) {
    console.log("Event is hidden, not adding or updating in Google Calendar");
    return;
  }

  const calendarEvent = formatCalendarEvent(eventData);
  const operation = eventData.googleEventId
    ? async (calendar, params) =>
        calendar.events.update({
          calendarId,
          eventId: params.googleEventId,
          resource: params.calendarEvent,
        })
    : async (calendar, params) =>
        calendar.events.insert({
          calendarId,
          resource: params.calendarEvent,
        });

  const result = await handleCalendarOperation(operation, {
    calendarEvent,
    googleEventId: eventData.googleEventId,
  });

  if (!eventData.googleEventId) {
    eventData.googleEventId = result.id;
    await eventData.save();
  }

  return result;
};

export const deleteCalendarEvent = async (eventData) => {
  const googleEventId = eventData.googleEventId; // todo: edge case
  if (!googleEventId) {
    console.error("No googleEventId found for the event.");
    return;
  }

  await handleCalendarOperation(
    (calendar, params) =>
      calendar.events.delete({
        calendarId,
        eventId: params.googleEventId,
      }),
    { googleEventId }
  );
  console.log("Event deleted:", googleEventId);
};

